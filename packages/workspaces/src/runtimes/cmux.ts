import { execFile, execFileSync } from "node:child_process";
import type { RuntimeDriver, RuntimeProbeResult, RuntimeSpawnOptions, WorkspaceRef, PaneRef, RuntimePaneOptions } from "./types.js";
import { resolveCmuxBin } from "@squadrant/shared";
import { checkToolCompat } from "@squadrant/shared";
import { compatManifest } from "@squadrant/shared";

// 15s — cmux operations are local IPC (sub-50ms normally). 15s covers unusual
// system load or a momentarily stuck cmux server without causing the captain
// blindness that an unbounded hang would (see #209).
export const CMUX_TIMEOUT = 15_000;

export class CmuxTimeoutError extends Error {
  constructor(cmd: string) {
    super(`cmux timeout after ${CMUX_TIMEOUT}ms on: ${cmd}`);
    this.name = "CmuxTimeoutError";
  }
}

import { DeferDelivery } from "@squadrant/core";

/** True when running inside a cmux workspace (CMUX_WORKSPACE_ID is set). */
export function isInsideCmux(): boolean {
  return !!process.env.CMUX_WORKSPACE_ID;
}

// Synchronous cmux invocation for select-workspace / current-workspace calls
// not yet abstracted behind RuntimeDriver. Uses execFileSync (no shell) with
// stderr piped so cmux diagnostic messages (e.g. "Pane not found") don't leak
// to the parent terminal. Returns trimmed stdout.
export function cmuxLocal(args: string[]): string {
  return execFileSync(resolveCmuxBin(), args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CMUX_TIMEOUT,
  }).trim();
}

// Invoke cmux with an argv array and NO shell. Every element (especially crew
// prompt text passed through send/send-to-surface) reaches cmux as a single
// literal argument — backticks, $(), quotes are never parsed. See #118.
// Async to avoid blocking the Node.js event loop during daemon timer ticks.
function cmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCmuxBin(),
      args,
      // CMUX_QUIET=1 silences cmux 0.64's one-time deprecation hints (e.g. the
      // "list-workspaces is now an alias for cmux workspace list" notice). Those
      // notices print to the command's stdout and would otherwise pollute the
      // output we parse. Inherit the rest of the environment unchanged.
      { encoding: "utf-8", timeout: CMUX_TIMEOUT, env: { ...process.env, CMUX_QUIET: "1" } },
      (err, stdout) => {
        if (err) {
          reject((err as NodeJS.ErrnoException).code === "ETIMEDOUT"
            ? new CmuxTimeoutError(args.join(" "))
            : err);
          return;
        }
        resolve((stdout as string).trim());
      },
    );
  });
}

// Shape of `cmux workspace list --json` (cmux 0.64.16). Only the fields we
// consume are typed; everything else in the payload is ignored.
interface CmuxWorkspaceListJson {
  workspaces?: Array<{
    ref?: string;
    custom_title?: string | null;
    has_custom_title?: boolean;
    current_directory?: string | null;
  }>;
}

// Shape of `cmux tree --json` (cmux 0.64.16). Surfaces nest as
// windows[].workspaces[].panes[].surfaces[]; only consumed fields are typed.
interface CmuxTreeJson {
  windows?: Array<{
    workspaces?: Array<{
      ref?: string;
      panes?: Array<{
        surfaces?: Array<{ ref?: string; surface_ref?: string; title?: string | null }>;
      }>;
    }>;
  }>;
}

// Parse `cmux workspace list --json` into WorkspaceRefs. Replaces the old
// regex over the human-readable `list-workspaces` text (audit B2). The display
// name is the workspace's custom title when set (byte-identical to what the
// text form showed, e.g. "⚓ squadrant-captain" — this is what squadrant matches
// captains by), falling back to the cwd for untitled workspaces.
function parseList(output: string): WorkspaceRef[] {
  let parsed: CmuxWorkspaceListJson;
  try {
    parsed = JSON.parse(output) as CmuxWorkspaceListJson;
  } catch {
    return [];
  }
  const refs: WorkspaceRef[] = [];
  for (const ws of parsed.workspaces ?? []) {
    if (!ws.ref) continue;
    refs.push({
      id: ws.ref,
      name: (ws.has_custom_title && ws.custom_title) ? ws.custom_title : (ws.current_directory ?? ws.ref),
      status: "running",
    });
  }
  return refs;
}

// cmux `send` treats \n, \r (and \t) as Enter/Tab keystrokes, so any newline in a
// multi-line message would submit it line-by-line. Collapse all newline/CR/tab
// (real bytes AND literal backslash-escapes) to single spaces so the whole message
// is delivered as one line, then the explicit send-key Enter submits it once.
export function sanitizeForCmuxSend(text: string): string {
  return text
    .replace(/\\[nrt]/g, " ")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Extract the in-progress draft from a cmux read-screen capture (#258 / #268).
 * Scans from the bottom of the screen so history lines that contain `> ` are
 * ignored; only the actual input area (the last matching line) is returned.
 * Handles both `>` (synthetic/test) and `❯` (U+276F, the real Claude Code
 * prompt character) as the input caret. The real prompt is followed by a
 * non-breaking space (U+00A0); JS `\s` covers it, so `\s+` matches either.
 * Also handles box-drawing `│ ❯ text │` variants.
 *
 * Three-state return (#268):
 *   "draft text" — input box found with content  → caller must DEFER
 *   ""           — input box positively confirmed empty → caller may DELIVER
 *   null         — HR boundaries not found (overlay/menu/scrolled) → caller must DEFER
 */
export function parseDraftFromScreen(screen: string): string | null {
  // Empty screen means the input box is definitely not visible — defer (#268).
  if (!screen) return null;
  const lines = screen.split(/\r?\n/);

  // Locate the last two HR lines (runs of U+2500 ─) — they are the bottom and top
  // boundaries of the live input box. Everything above the top HR is transcript
  // content and is never scanned, preventing sent user messages with a ❯/> prefix
  // from being mistaken for the live draft (#258).
  const HR_RE = /^\s*─{10,}\s*$/;
  let bottomHR = -1;
  let topHR = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HR_RE.test(lines[i])) {
      if (bottomHR === -1) {
        bottomHR = i;
      } else {
        topHR = i;
        break;
      }
    }
  }

  // Can't locate both boundaries — input box not visible (overlay/menu/scrolled
  // transcript). Defer so keystrokes never land in an unknown UI state (#268).
  if (topHR === -1) return null;

  // Extract content lines strictly between the two HRs (the live input box only).
  const inputLines = lines.slice(topHR + 1, bottomHR);

  for (const line of inputLines) {
    let extracted: string | undefined;
    // Box-drawing input line: │ [>❯] text │
    const boxMatch = line.match(/│\s*[>❯]\s+(.*?)\s*│/);
    if (boxMatch) {
      extracted = boxMatch[1].trim();
    } else {
      // Plain input line — allow empty content after the prompt glyph
      const plainMatch = line.match(/^\s*[>❯]\s*(.*)$/);
      if (plainMatch) extracted = plainMatch[1].trim();
    }
    if (extracted !== undefined) {
      // Heuristic #1 — Leading cursor glyph (▌/█) at position 0.
      // CC renders its input cursor via native ANSI terminal positioning, NOT as a ▌ cell
      // character: a live cmux read-screen of an idle CC session with cursor at position 0
      // yields ❯\xa0 with no ▌ (confirmed by 258-parse-bug-fixture.txt L24 and a fresh
      // crew session capture). Therefore ▌ at the start cannot arise from the user moving
      // the cursor to the beginning of real typed text — it only appears when CC itself
      // renders a UI placeholder at that position (#294). Safe to treat as empty. (#297)
      if (/^[▌█▔▎▏▌█]/.test(extracted)) continue;

      // Strip terminal cursor glyphs (▌, █, etc.) that trail the caret position
      const draft = extracted.replace(/\s*[▌█▔▎▏▌█]+\s*$/, "").trim();

      // Claude Code UI placeholder: appears in Working state when input is locked
      // (user cannot type). "Press [key] to [action]" strings are UI instructions
      // shown as ghost suggestions — never real user-typed content (#294).
      if (/^Press\s+(?:up|down|left|right|enter|escape|esc|tab|any\s+key|ctrl|shift|alt)\s+to\s+/i.test(draft)) continue;

      if (draft) return draft;
    }
  }

  return "";
}

/**
 * True when the screen contains a real Claude Code input box — two HR boundaries
 * AND at least one line between them with the CC prompt glyph (❯ or >). This
 * distinguishes the CC input box from the claude-mem startup banner, which can
 * produce HR-bounded regions WITHOUT a prompt glyph and stabilise before CC
 * renders its own TUI. parseDraftFromScreen returns "" for both cases (two HRs
 * found, no ❯ inside), so !==null does not distinguish them (#466-single fix).
 */
export function hasCCInputBox(screen: string): boolean {
  if (!screen) return false;
  const lines = screen.split(/\r?\n/);
  const HR_RE = /^\s*─{10,}\s*$/;
  let bottomHR = -1;
  let topHR = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HR_RE.test(lines[i])) {
      if (bottomHR === -1) bottomHR = i;
      else { topHR = i; break; }
    }
  }
  if (topHR === -1) return false;
  return lines.slice(topHR + 1, bottomHR).some((l) => /[>❯]/.test(l));
}

/**
 * True when the HR-bounded region is an AskUserQuestion / permission-approval
 * SELECTION MODAL rather than the genuine CC input box (#484). Both draw their
 * own pair of ── borders and highlight the selected option with the same ❯
 * glyph as a real draft, so neither parseDraftFromScreen nor hasCCInputBox can
 * tell them apart — a live-captured frame confirms parseDraftFromScreen
 * returns the highlighted option's own label ("1. Red"), not "" or null (see
 * docs/reports/484-askuserquestion-fixture.txt). CC renders every selectable
 * option (AskUserQuestion AND the Bash-approval picker) as a "N. Label" line,
 * which a real typed draft or ghost/hint placeholder never does — that's the
 * positive signal used here.
 */
export function hasModalOptionList(screen: string): boolean {
  if (!screen) return false;
  const lines = screen.split(/\r?\n/);
  const HR_RE = /^\s*─{10,}\s*$/;
  let bottomHR = -1;
  let topHR = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HR_RE.test(lines[i])) {
      if (bottomHR === -1) bottomHR = i;
      else { topHR = i; break; }
    }
  }
  if (topHR === -1) return false;
  return lines.slice(topHR + 1, bottomHR).some((l) => /^\s*\d+\.\s/.test(l));
}

/**
 * Extract the RAW input-box content for the #302 buffer-liveness probe — all
 * content lines between the last two HRs, joined, with the prompt glyph and any
 * trailing cursor glyph stripped (but NOT the #294 ghost heuristics: the probe
 * needs the literal rendered text to diff before/after a backspace). Returns
 * null if the box boundaries aren't visible (overlay/scroll). Unlike
 * parseDraftFromScreen this captures EVERY content line, so a multi-line draft's
 * change on its last line is not missed.
 */
export function readInputBoxRaw(
  screen: string,
  opts?: { trim?: boolean },
): string | null {
  if (!screen) return null;
  const lines = screen.split(/\r?\n/);
  const HR_RE = /^\s*─{10,}\s*$/;
  let bottomHR = -1;
  let topHR = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HR_RE.test(lines[i])) {
      if (bottomHR === -1) bottomHR = i;
      else { topHR = i; break; }
    }
  }
  if (topHR === -1) return null;
  const parts: string[] = [];
  for (const line of lines.slice(topHR + 1, bottomHR)) {
    let s = line.replace(/│/g, " ");        // drop box-drawing borders
    s = s.replace(/^\s*[>❯]\s?/, "");        // drop the leading prompt glyph + one space
    s = s.replace(/\s*[▌█▔▎▏]+\s*$/, "");    // drop a trailing cursor glyph
    parts.push(s);
  }
  const joined = parts.join("");
  // Default: trim trailing whitespace. Pass { trim: false } to preserve it —
  // used by the probe branch to detect whether a backspace was a no-op (#258).
  return opts?.trim === false ? joined : joined.replace(/\s+$/, "");
}

// #292: Claude Code renders a persistent bottom status block once its TUI is past
// the cold-init splash — the auto-mode indicator (⏵⏵), the context meter
// ("Ctx Used"), the shortcuts hint, or the accept-edits toggle. Absence of all of
// these means we're still on the loading/splash screen, where keystrokes are
// silently dropped (#235). Grounded in docs/reports/258-parse-bug-fixture.txt.
const CC_INITIALIZED_RE = /⏵⏵|Ctx Used|for shortcuts|accept edits/i;

// A live turn shows a working spinner. The whimsical verb ("Working…",
// "Cerebrating…", "Crunched…") varies across versions, so we key on stable
// markers instead. CRUCIAL: a turn is NOT always streaming tokens — during a
// tool wait (e.g. the shell commands the captain startup checklist runs first)
// the spinner reads "✻ Crunched for 27s · 1 shell still running", which carries
// NO token-down-counter and no "esc to interrupt". Keying only on those two
// (the original #292 mistake) misread a shell-waiting captain as "idle", so the
// startup-prompt loop re-sent on every poll → 3 duplicate startup runs. We now
// also match the shell-running hint and the in-parens elapsed timer ("(4s",
// "(1m 4s") — both confined to the live spinner line, never on an idle,
// input-ready screen. Grounded in docs/reports/258-parse-bug-fixture.txt
// (line 4: shell-wait, no counter; line 22: token-stream).
const CC_WORKING_RE = /↓\s*[\d.]+\s*k?\s*tokens?\b|esc to interrupt|\bshell still running\b|·\s*\d+\s*shell\b|\(\d+m?\s*\d*s\b/i;

/**
 * Classify a captain surface's read-screen into the three states #292's
 * deterministic startup delivery needs:
 *   "loading" — splash / cold-init; keystrokes would be dropped, do not send yet.
 *   "idle"    — TUI up and accepting input; safe to deliver the startup prompt.
 *   "working" — a turn is in flight; sending would queue a DUPLICATE startup run.
 * "working" is checked first so an active spinner above an (empty) input box wins.
 */
export function classifyStartupSurface(screen: string): "loading" | "idle" | "working" {
  if (CC_WORKING_RE.test(screen)) return "working";
  if (CC_INITIALIZED_RE.test(screen)) return "idle";
  return "loading";
}

// #339 instrumentation gate. The DONE→captain submit is a text burst then a
// SEPARATE send-key Enter (two distinct socket writes); intermittently the Enter
// lands as a newline instead of a submit, stranding the payload in the input box.
// Root-causing needs ONE real frame in the wild. Gated behind SQUADRANT_DEBUG_SEND
// so it is a strict no-op — zero extra reads, zero latency — when unset.
export function sendDebugEnabled(): boolean {
  return !!process.env.SQUADRANT_DEBUG_SEND;
}

// Classify a post-send input-box read into a submit verdict for #339:
//   "submitted" — box empty after Enter (the payload left the input box)
//   "stuck"     — box still holds the payload (Enter inserted a newline, no submit)
//   "box-gone"  — box not visible post-send (overlay/scroll — inconclusive)
//   "unknown"   — box has unrelated content (a fresh draft / next turn rendered)
export function classifySendOutcome(payload: string, postBox: string | null): string {
  if (postBox === null) return "box-gone";
  if (postBox === "") return "submitted";
  if (postBox === payload || postBox.includes(payload)) return "stuck";
  return "unknown";
}

export type DraftLiveness = "real-draft" | "no-draft" | "inconclusive";

/**
 * Pure probe-liveness decision (#258 fix).
 * Given `before` / `after` raw box readings (from readInputBoxRaw) around a
 * single backspace, classify whether a real user draft was present.
 *
 * Three-way result — caller mapping:
 *   "real-draft"   → restore last grapheme, throw DeferDelivery
 *   "no-draft"     → deliver (ghost positively confirmed dismissed to empty)
 *   "inconclusive" → throw DeferDelivery (bias: protect human, delay bot)
 *
 * "Inconclusive" covers: after===before (ghost-invariant OR trailing-space
 * trim makes them equal — indistinguishable), null after-read (timing/overlay),
 * and any other mismatch not explained by grapheme removal. The old code treated
 * all of these as "no-draft" (fall-through to deliver), which is the #258 clobber.
 */
export function classifyDraftLiveness(
  before: string | null,
  after: string | null,
): DraftLiveness {
  if (before === null || after === null) return "inconclusive";

  // Ghost dismissed to empty → positively confirmed no real draft remains.
  if (after === "") return "no-draft";

  // Grapheme-aware last-grapheme-removal check (Node 16+ / Intl.Segmenter).
  // Removes the last grapheme cluster from `before`, trims trailing whitespace
  // (matching what readInputBoxRaw does on the re-rendered screen), then
  // compares to `after`. Handles emoji, wide chars, and combining sequences
  // that slice(0,-1) gets wrong by removing only one UTF-16 code unit.
  if (before.length > 0) {
    const segs = [...new Intl.Segmenter().segment(before)];
    const expected = segs
      .slice(0, -1)
      .map((s) => s.segment)
      .join("")
      .replace(/\s+$/, "");
    if (after === expected) return "real-draft";
  }

  // Everything else — after===before (ghost-invariant or trailing-space trim),
  // arbitrary mismatch, or other ambiguity — is inconclusive. Defer to protect
  // the human; a correctly empty box always produces after==="" (caught above).
  return "inconclusive";
}

export function createCmuxDriver(): RuntimeDriver {
  return {
    name: "cmux",

    async probe(): Promise<RuntimeProbeResult> {
      try {
        const version = await cmux(["--version"]);
        const warn = checkToolCompat("cmux", version, compatManifest.tools.cmux);
        if (warn) process.stderr.write(`[squadrant] ${warn}\n`);
        return { installed: true, version };
      } catch {
        return { installed: false, version: "" };
      }
    },

    async list(): Promise<WorkspaceRef[]> {
      try {
        // --json: structured output (B2); --id-format refs: ids as
        // workspace:N refs, not numeric (from #325). Both are required.
        return parseList(await cmux(["workspace", "list", "--json", "--id-format", "refs"]));
      } catch {
        return [];
      }
    },

    async status(nameOrId: string): Promise<WorkspaceRef | null> {
      const refs = await this.list();
      const hit = refs.find((r) => r.name === nameOrId || r.id === nameOrId);
      return hit ?? null;
    },

    async spawn(opts: RuntimeSpawnOptions): Promise<WorkspaceRef> {
      const newWorkspaceArgs = ["workspace", "create", "--command", opts.command];
      if (opts.workdir) newWorkspaceArgs.push("--cwd", opts.workdir);
      const output = await cmux(newWorkspaceArgs);
      const id = output.match(/workspace:\d+/)?.[0] || output.split(/\s+/).pop() || "";
      if (!id) {
        throw new Error(`cmux spawn did not return a workspace id: ${output}`);
      }
      await cmux(["workspace", "rename", id, "--title", opts.name]);
      // Rename the initial tab to the workspace name so send() can route to it
      let initialSurface: string | undefined;
      try {
        const tree = await cmux(["tree", "--workspace", id, "--id-format", "refs"]);
        const m = tree.match(/surface\s+(surface:\d+)\s+\[\w+\]\s+"([^"]*)"/);
        if (m) {
          initialSurface = m[1];
          await cmux(["rename-tab", "--workspace", id, "--surface", m[1], opts.name]);
        }
      } catch { /* rename is best-effort */ }
      if (opts.pinToTop) {
        try {
          await cmux(["workspace-action", "--workspace", id, "--action", "pin"]);
        } catch { /* workspace may not be pinned — proceed to close regardless */ }
        if (initialSurface) {
          try {
            await cmux(["tab-action", "--workspace", id, "--surface", initialSurface, "--action", "pin"]);
          } catch { /* tab pin is best-effort */ }
        }
      }
      return { id, name: opts.name, status: "running" };
    },

    async send(ref: string, message: string): Promise<void> {
      // Route to the tab named after the workspace (e.g. ":captain" tab) so
      // messages don't land on a focused crew tab by mistake.  Fall back to
      // workspace-level send when no matching tab is found.
      const allRefs = await this.list();
      const ws = allRefs.find((r) => r.id === ref);
      if (ws) {
        try {
          const surfaces = await this.listSurfaces(ws.id);
          const target = surfaces.find((s) => s.title === ws.name);
          if (target) {
            await cmux(["send", "--workspace", ws.id, "--surface", target.surfaceId, sanitizeForCmuxSend(message)]);
            await cmux(["send-key", "--workspace", ws.id, "--surface", target.surfaceId, "Enter"]);
            return;
          }
        } catch { /* fall through to default */ }
      }
      await cmux(["send", "--workspace", ref, sanitizeForCmuxSend(message)]);
      await cmux(["send-key", "--workspace", ref, "Enter"]);
    },

    async sendKey(ref: string, key: string): Promise<void> {
      await cmux(["send-key", "--workspace", ref, key]);
    },

    async readScreen(ref: string): Promise<string> {
      try {
        return await cmux(["read-screen", "--workspace", ref]);
      } catch {
        return "";
      }
    },

    async stop(ref: string): Promise<void> {
      // cmux 0.64.16 refuses to close a pinned workspace. Unpin first so that
      // squadrant launch --fresh works even when the captain workspace is pinned.
      try {
        await cmux(["workspace-action", "--workspace", ref, "--action", "unpin"]);
      } catch { /* workspace may not be pinned — proceed to close regardless */ }
      try {
        await cmux(["workspace", "close", ref]);
      } catch { /* may already be closed */ }
    },

    async newPane(opts: RuntimePaneOptions): Promise<PaneRef> {
      // #295 / audit A1+B3: a crew tab must never steal focus from the captain.
      // cmux 0.64.16's new-surface and new-pane both DEFAULT to --focus false,
      // so we pass it explicitly (intent + resilience if the default changes)
      // and create the surface focus-neutrally. This REPLACES the old
      // snapshot-then-move-surface refocus dance, which depended on the fragile
      // "tree order == array index" invariant that the 0.64 freeform canvas +
      // staggered restore broke — risking a focus-steal regression.
      const cmd = opts.direction === "tab"
        ? ["new-surface", "--type", "terminal", "--workspace", opts.workspaceId, "--focus", "false"]
        : ["new-pane", "--type", "terminal", "--direction", opts.direction, "--workspace", opts.workspaceId, "--focus", "false"];
      const output = await cmux(cmd);
      const surfaceId = output.match(/surface:\d+/)?.[0];
      if (!surfaceId) {
        const verb = opts.direction === "tab" ? "new-surface" : "new-pane";
        throw new Error(`cmux ${verb} did not return a surface id: ${output}`);
      }
      if (opts.title) {
        try {
          await cmux(["rename-tab", "--workspace", opts.workspaceId, "--surface", surfaceId, "--title", opts.title]);
        } catch { /* rename is best-effort */ }
      }
      return { workspaceId: opts.workspaceId, surfaceId };
    },

    async closePane(pane: PaneRef): Promise<void> {
      try {
        await cmux(["close-surface", "--workspace", pane.workspaceId, "--surface", pane.surfaceId]);
      } catch { /* may already be closed */ }
    },

    async sendToPane(pane: PaneRef, message: string): Promise<void> {
      await this.pasteToPane(pane, message);
      await this.sendKeyToPane(pane, "Enter");
    },

    async pasteToPane(pane: PaneRef, text: string): Promise<void> {
      await cmux(["send", "--workspace", pane.workspaceId, "--surface", pane.surfaceId, sanitizeForCmuxSend(text)]);
    },

    async sendKeyToPane(pane: PaneRef, key: string): Promise<void> {
      await cmux(["send-key", "--workspace", pane.workspaceId, "--surface", pane.surfaceId, key]);
    },

    async readPaneScreen(pane: PaneRef): Promise<string> {
      try {
        return await cmux(["read-screen", "--workspace", pane.workspaceId, "--surface", pane.surfaceId]);
      } catch {
        return "";
      }
    },

    async spawnInjector(opts: {
      captainWorkspace: WorkspaceRef;
      command: string;
      title?: string;
      placement: "background" | "visible";
    }): Promise<PaneRef> {
      // Both placements use a background tab (new-surface) in the captain's
      // existing pane — full-height, NO split. A split-pane is wrong here:
      // cmux 0.62.2 has no resize/hide verb, so a `new-pane` split can never be
      // shrunk and stays an ugly full-height 50/50 split forever (#117). The
      // relay still runs as a cmux descendant in the same workspace, preserving
      // the in-cmux delivery requirement (#112).
      //
      // cmux 0.64.16's new-surface DEFAULTS to --focus false, so "background"
      // passes --focus false and the relay tab is created without ever stealing
      // focus from the captain — no snapshot-then-move-surface refocus dance
      // (audit A1+B3; the 0.64 freeform canvas broke the old tree-order==index
      // assumption it relied on). "visible" passes --focus true to leave the
      // debug tab focused for ergonomics.
      const wsId = opts.captainWorkspace.id;
      const focus = opts.placement === "visible" ? "true" : "false";
      const output = await cmux(["new-surface", "--type", "terminal", "--workspace", wsId, "--focus", focus]);
      const surfaceId = output.match(/surface:\d+/)?.[0];
      if (!surfaceId) {
        throw new Error(`cmux spawnInjector did not return a surface id: ${output}`);
      }
      if (opts.title) {
        try {
          await cmux(["rename-tab", "--workspace", wsId, "--surface", surfaceId, "--title", opts.title]);
        } catch { /* rename is best-effort */ }
      }
      await cmux(["send", "--workspace", wsId, "--surface", surfaceId, opts.command]);
      await cmux(["send-key", "--workspace", wsId, "--surface", surfaceId, "Enter"]);
      return { workspaceId: wsId, surfaceId, title: opts.title };
    },

    async sendToSurface(surface: PaneRef, text: string, opts?: { probe?: boolean }): Promise<void> {
      const ws = surface.workspaceId;
      const sf = surface.surfaceId;
      const deliver = async () => {
        // #339 debug-gated instrumentation. When OFF this is the exact two-write
        // submit it always was (no extra reads, no latency). When ON we capture
        // one real frame: the input box BEFORE the send, the payload, and the box
        // AFTER the Enter — so a stranded submit can be told apart from a clean one.
        const dbg = sendDebugEnabled();
        let preBox: string | null = null;
        if (dbg) {
          try {
            preBox = readInputBoxRaw(await cmux(["read-screen", "--workspace", ws, "--surface", sf]));
          } catch { /* unreadable — leave preBox null, logged as such */ }
        }
        const payload = sanitizeForCmuxSend(text);
        await cmux(["send", "--workspace", ws, "--surface", sf, payload]);
        await cmux(["send-key", "--workspace", ws, "--surface", sf, "Enter"]);
        // Post-send read-back is READ-ONLY — never a re-send — so it can NEVER
        // double-submit (the #339 constraint). It only observes whether the box
        // still holds the payload (Enter mis-landed) or is empty (submit took).
        if (dbg) {
          let postBox: string | null = null;
          try {
            postBox = readInputBoxRaw(await cmux(["read-screen", "--workspace", ws, "--surface", sf]));
          } catch { /* unreadable — leave postBox null, classified box-gone */ }
          const verdict = classifySendOutcome(payload, postBox);
          process.stderr.write(`[squadrant] send-debug ${JSON.stringify({ surface: sf, verdict, payload, preBox, postBox })}\n`);
        }
      };

      // #258/#268 Approach B: deliver only when the captain's input is positively
      // confirmed empty. null = box not visible (overlay/menu/scroll) → always defer.
      let screen = "";
      try {
        screen = await cmux(["read-screen", "--workspace", ws, "--surface", sf]);
      } catch { /* screen unreadable — parseDraftFromScreen("") → null → defer below */ }
      const draft = parseDraftFromScreen(screen);

      // null = box not confirmed visible → never keystroke into an overlay (#268).
      if (draft === null) throw new DeferDelivery(null);

      // #484: an AskUserQuestion / permission-approval SELECTION MODAL — never
      // deliver into it, regardless of what parseDraftFromScreen returned or
      // whether this call is probe-escalated. Checked before the probe branch
      // below because the probe's backspace-no-op check can't tell "ghost
      // placeholder" apart from "selection list" (backspace is a no-op
      // against both) and would otherwise call deliver(), typing the message
      // and pressing Enter into the picker — auto-confirming whichever option
      // is highlighted.
      if (hasModalOptionList(screen)) throw new DeferDelivery(null);

      // Empty input — nothing to protect, deliver directly.
      if (draft === "") { await deliver(); return; }

      // A draft is present. On the hot path (no probe) we NEVER keystroke — we
      // defer and carry the content so the relay can track stability (#302).
      if (!opts?.probe) throw new DeferDelivery(draft);

      // #302 buffer-liveness probe. classifyDraftLiveness decides from the
      // before/after box readings whether a real draft is present (#258 fix).
      // Capture both trimmed (for classification) and untrimmed (for no-op
      // detection in the inconclusive branch) before sending the backspace.
      const before = readInputBoxRaw(screen);
      const rawBefore = readInputBoxRaw(screen, { trim: false });
      await cmux(["send-key", "--workspace", ws, "--surface", sf, "backspace"]);
      // 50ms settle: give the TUI time to re-render before reading back the
      // result. Without this, a too-fast read may still show the pre-backspace
      // content, producing a false after===before (timing-race #258).
      await new Promise<void>((r) => setTimeout(r, 50));
      let afterScreen = "";
      try {
        afterScreen = await cmux(["read-screen", "--workspace", ws, "--surface", sf]);
      } catch { /* unreadable — after stays "", readInputBoxRaw → null → inconclusive → defer */ }
      const after = readInputBoxRaw(afterScreen);
      const rawAfter = readInputBoxRaw(afterScreen, { trim: false });

      const liveness = classifyDraftLiveness(before, after);
      if (liveness === "real-draft") {
        // Confirmed real draft. Restore the last grapheme our probe removed
        // (grapheme-aware — not slice(-1) which breaks emoji, #258), then defer.
        const segs = before ? [...new Intl.Segmenter().segment(before)] : [];
        const lastGrapheme =
          segs.length > 0 ? segs[segs.length - 1].segment : before!.slice(-1);
        await cmux(["send", "--workspace", ws, "--surface", sf, lastGrapheme]);
        throw new DeferDelivery(draft);
      }
      if (liveness === "no-draft") {
        // Ghost positively dismissed to empty — safe to deliver.
        await deliver(); return;
      }
      // 'inconclusive': could be ghost-invariant (true no-op) or trailing-space
      // draft (backspace removed the space but trim masked it). Distinguish by
      // comparing the UNTRIMMED raw content.
      if (rawBefore !== null && rawAfter !== null) {
        if (rawBefore !== rawAfter) {
          // Raw changed: real trailing-space (or similar) draft — backspace consumed
          // a real character. Restore the removed grapheme then defer (#258).
          const segs = [...new Intl.Segmenter().segment(rawBefore)];
          const lastGrapheme =
            segs.length > 0 ? segs[segs.length - 1].segment : rawBefore.slice(-1);
          await cmux(["send", "--workspace", ws, "--surface", sf, lastGrapheme]);
          throw new DeferDelivery(draft);
        }
        // rawBefore === rawAfter: backspace was a true no-op — the box holds ghost/hint
        // text (non-editable). A real draft ALWAYS changes under backspace. Deliver.
        await deliver(); return;
      }
      // Null raw reads: can't distinguish ghost from draft → defer (bias: protect human).
      throw new DeferDelivery(draft);
    },

    async listSurfaces(workspaceId: string): Promise<PaneRef[]> {
      let output: string;
      try {
        // --json: structured output (B2); --id-format refs: surface ids as
        // surface:N refs, not numeric (from #325). Both are required.
        output = await cmux(["tree", "--workspace", workspaceId, "--json", "--id-format", "refs"]);
      } catch {
        return [];
      }
      let parsed: CmuxTreeJson;
      try {
        parsed = JSON.parse(output) as CmuxTreeJson;
      } catch {
        return [];
      }
      // Navigate windows[].workspaces[].panes[].surfaces[], collecting every
      // surface that belongs to the requested workspace. Replaces the old regex
      // over `cmux tree` text (audit B2). Surface refs are globally unique, so
      // filtering by the parent workspace ref is sufficient.
      const surfaces: PaneRef[] = [];
      for (const win of parsed.windows ?? []) {
        for (const ws of win.workspaces ?? []) {
          if (ws.ref !== workspaceId) continue;
          for (const pane of ws.panes ?? []) {
            for (const sf of pane.surfaces ?? []) {
              const ref = sf.ref ?? sf.surface_ref;
              if (ref) surfaces.push({ workspaceId, surfaceId: ref, title: sf.title ?? "" });
            }
          }
        }
      }
      return surfaces;
    },
  };
}
