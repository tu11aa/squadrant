import { execFileSync } from "node:child_process";
import type { RuntimeDriver, RuntimeProbeResult, RuntimeSpawnOptions, WorkspaceRef, PaneRef, RuntimePaneOptions } from "./types.js";
import { resolveCmuxBin } from "../lib/cmux-bin.js";

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

// #258 Approach B: thrown by sendToSurface when the captain has any draft in
// the input box. The relay defers delivery until the input is empty.
export class DeferDelivery extends Error {
  constructor() {
    super("deferred: captain composing");
    this.name = "DeferDelivery";
  }
}

// Invoke cmux with an argv array and NO shell. Every element (especially crew
// prompt text passed through send/send-to-surface) reaches cmux as a single
// literal argument — backticks, $(), quotes are never parsed. See #118.
function cmux(args: string[]): string {
  try {
    return execFileSync(resolveCmuxBin(), args, { encoding: "utf-8", timeout: CMUX_TIMEOUT }).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new CmuxTimeoutError(args.join(" "));
    }
    throw err;
  }
}

function parseList(output: string): WorkspaceRef[] {
  const refs: WorkspaceRef[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/(workspace:\d+)\s+(.+?)(?:\s+\(.*\))?(?:\s+\[selected\])?$/);
    if (match) {
      refs.push({
        id: match[1],
        name: match[2].trim(),
        status: "running",
      });
    }
  }
  return refs;
}

// Parse `cmux tree` into the ordered list of surfaces in a workspace, marking
// which one is currently selected. Order matches the tab strip, so the array
// index doubles as the surface's position for move-surface --index.
function parseSurfaceOrder(tree: string): { id: string; selected: boolean }[] {
  const surfaces: { id: string; selected: boolean }[] = [];
  for (const line of tree.split("\n")) {
    const match = line.match(/surface\s+(surface:\d+)/);
    if (match) {
      surfaces.push({ id: match[1], selected: line.includes("[selected]") });
    }
  }
  return surfaces;
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
 * Also handles box-drawing `│ ❯ text │` variants.
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
      // Strip terminal cursor glyphs (▌, █, etc.) that trail the caret position
      const draft = extracted.replace(/\s*[▌█▔▎▏▌█]+\s*$/, "").trim();
      if (draft) return draft;
    }
  }

  return "";
}

export function createCmuxDriver(): RuntimeDriver {
  return {
    name: "cmux",

    async probe(): Promise<RuntimeProbeResult> {
      try {
        const version = cmux(["--version"]);
        return { installed: true, version };
      } catch {
        return { installed: false, version: "" };
      }
    },

    async list(): Promise<WorkspaceRef[]> {
      try {
        return parseList(cmux(["list-workspaces"]));
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
      const newWorkspaceArgs = ["new-workspace", "--command", opts.command];
      if (opts.workdir) newWorkspaceArgs.push("--cwd", opts.workdir);
      const output = cmux(newWorkspaceArgs);
      const id = output.match(/workspace:\d+/)?.[0] || output.split(/\s+/).pop() || "";
      if (!id) {
        throw new Error(`cmux spawn did not return a workspace id: ${output}`);
      }
      cmux(["rename-workspace", "--workspace", id, opts.name]);
      // Rename the initial tab to the workspace name so send() can route to it
      let initialSurface: string | undefined;
      try {
        const tree = cmux(["tree", "--workspace", id]);
        const m = tree.match(/surface\s+(surface:\d+)\s+\[\w+\]\s+"([^"]*)"/);
        if (m) {
          initialSurface = m[1];
          cmux(["rename-tab", "--workspace", id, "--surface", m[1], opts.name]);
        }
      } catch { /* rename is best-effort */ }
      if (opts.pinToTop) {
        try {
          cmux(["workspace-action", "--workspace", id, "--action", "pin"]);
        } catch { /* pin is best-effort */ }
        if (initialSurface) {
          try {
            cmux(["tab-action", "--workspace", id, "--surface", initialSurface, "--action", "pin"]);
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
            cmux(["send", "--workspace", ws.id, "--surface", target.surfaceId, sanitizeForCmuxSend(message)]);
            cmux(["send-key", "--workspace", ws.id, "--surface", target.surfaceId, "Enter"]);
            return;
          }
        } catch { /* fall through to default */ }
      }
      cmux(["send", "--workspace", ref, sanitizeForCmuxSend(message)]);
      cmux(["send-key", "--workspace", ref, "Enter"]);
    },

    async sendKey(ref: string, key: string): Promise<void> {
      cmux(["send-key", "--workspace", ref, key]);
    },

    async readScreen(ref: string): Promise<string> {
      try {
        return cmux(["read-screen", "--workspace", ref]);
      } catch {
        return "";
      }
    },

    async stop(ref: string): Promise<void> {
      try {
        cmux(["close-workspace", "--workspace", ref]);
      } catch { /* may already be closed */ }
    },

    async newPane(opts: RuntimePaneOptions): Promise<PaneRef> {
      const cmd = opts.direction === "tab"
        ? ["new-surface", "--type", "terminal", "--workspace", opts.workspaceId]
        : ["new-pane", "--type", "terminal", "--direction", opts.direction, "--workspace", opts.workspaceId];
      const output = cmux(cmd);
      const surfaceId = output.match(/surface:\d+/)?.[0];
      if (!surfaceId) {
        const verb = opts.direction === "tab" ? "new-surface" : "new-pane";
        throw new Error(`cmux ${verb} did not return a surface id: ${output}`);
      }
      if (opts.title) {
        try {
          cmux(["rename-tab", "--workspace", opts.workspaceId, "--surface", surfaceId, "--title", opts.title]);
        } catch { /* rename is best-effort */ }
      }
      return { workspaceId: opts.workspaceId, surfaceId };
    },

    async closePane(pane: PaneRef): Promise<void> {
      try {
        cmux(["close-surface", "--workspace", pane.workspaceId, "--surface", pane.surfaceId]);
      } catch { /* may already be closed */ }
    },

    async sendToPane(pane: PaneRef, message: string): Promise<void> {
      cmux(["send", "--workspace", pane.workspaceId, "--surface", pane.surfaceId, sanitizeForCmuxSend(message)]);
      cmux(["send-key", "--workspace", pane.workspaceId, "--surface", pane.surfaceId, "Enter"]);
    },

    async readPaneScreen(pane: PaneRef): Promise<string> {
      try {
        return cmux(["read-screen", "--workspace", pane.workspaceId, "--surface", pane.surfaceId]);
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
      // "background" then re-selects whatever surface was focused before, in its
      // original position, so the relay tab never steals focus from the
      // captain. "visible" leaves the new tab focused for debug ergonomics.
      const wsId = opts.captainWorkspace.id;
      let priorSurface: string | undefined;
      let priorIndex = -1;
      if (opts.placement === "background") {
        try {
          const before = parseSurfaceOrder(cmux(["tree", "--workspace", wsId]));
          priorIndex = before.findIndex((s) => s.selected);
          if (priorIndex >= 0) priorSurface = before[priorIndex].id;
        } catch { /* best-effort: if we can't read the tree, skip refocus */ }
      }
      const output = cmux(["new-surface", "--type", "terminal", "--workspace", wsId]);
      const surfaceId = output.match(/surface:\d+/)?.[0];
      if (!surfaceId) {
        throw new Error(`cmux spawnInjector did not return a surface id: ${output}`);
      }
      if (opts.title) {
        try {
          cmux(["rename-tab", "--workspace", wsId, "--surface", surfaceId, "--title", opts.title]);
        } catch { /* rename is best-effort */ }
      }
      cmux(["send", "--workspace", wsId, "--surface", surfaceId, opts.command]);
      cmux(["send-key", "--workspace", wsId, "--surface", surfaceId, "Enter"]);
      if (opts.placement === "background" && priorSurface) {
        try {
          cmux(["move-surface", "--surface", priorSurface, "--index", String(priorIndex), "--focus", "true"]);
        } catch { /* refocus is best-effort */ }
      }
      return { workspaceId: wsId, surfaceId, title: opts.title };
    },

    async sendToSurface(surface: PaneRef, text: string, opts?: { force?: boolean }): Promise<void> {
      // #258/#268 Approach B: deliver only when the captain's input is positively
      // confirmed empty. null = box not visible (overlay/menu/scroll) → always defer.
      let draft: string | null = null;
      try {
        const screen = cmux(["read-screen", "--workspace", surface.workspaceId, "--surface", surface.surfaceId]);
        draft = parseDraftFromScreen(screen);
      } catch { /* screen unreadable — draft stays null, will defer below */ }

      // null = box not confirmed visible → never keystroke into an overlay (#268).
      if (draft === null) {
        throw new DeferDelivery();
      }

      if (draft && !opts?.force) {
        // Captain is composing — defer until input clears (relay retries next poll).
        throw new DeferDelivery();
      }

      if (draft && opts?.force) {
        // Walk-away last-resort: backspace×(N+2) clears, deliver, restore draft.
        const backspaceCount = draft.length + 2;
        for (let i = 0; i < backspaceCount; i++) {
          cmux(["send-key", "--workspace", surface.workspaceId, "--surface", surface.surfaceId, "backspace"]);
        }
        cmux(["send", "--workspace", surface.workspaceId, "--surface", surface.surfaceId, sanitizeForCmuxSend(text)]);
        cmux(["send-key", "--workspace", surface.workspaceId, "--surface", surface.surfaceId, "Enter"]);
        cmux(["send", "--workspace", surface.workspaceId, "--surface", surface.surfaceId, sanitizeForCmuxSend(draft)]);
      } else {
        // Input is empty — deliver directly, nothing to protect.
        cmux(["send", "--workspace", surface.workspaceId, "--surface", surface.surfaceId, sanitizeForCmuxSend(text)]);
        cmux(["send-key", "--workspace", surface.workspaceId, "--surface", surface.surfaceId, "Enter"]);
      }
    },

    async listSurfaces(workspaceId: string): Promise<PaneRef[]> {
      let output: string;
      try {
        output = cmux(["tree", "--workspace", workspaceId]);
      } catch {
        return [];
      }
      const surfaces: PaneRef[] = [];
      // tree output line example:
      //     ├── surface surface:30 [terminal] "🔧 pact-network:crew-1" [selected]
      const re = /surface\s+(surface:\d+)\s+\[\w+\]\s+"([^"]*)"/;
      for (const line of output.split("\n")) {
        const match = line.match(re);
        if (match) {
          surfaces.push({ workspaceId, surfaceId: match[1], title: match[2] });
        }
      }
      return surfaces;
    },
  };
}
