// Workspace-boot orchestration — driver-agnostic algorithm (#367 command-thinning).
// CLI-edge concerns (concrete driver construction, cmuxLocal, buildAgentCmd) are
// injected as closures; core only imports from @squadrant/shared.

import type { RuntimeDriver } from "@squadrant/shared";
import { shouldStartFresh, recordSession } from "./session-freshness.js";

// ─── deliverStartupPrompt ────────────────────────────────────────────────────

export type StartupSurfaceState = "loading" | "idle" | "working";

export interface StartupDeliveryOptions {
  /** Max time to wait for the surface to leave the cold-init splash. */
  readyTimeoutMs?: number;
  /** Pause after a send before checking whether the turn started. */
  settleMs?: number;
  /** Poll cadence while waiting for readiness. */
  pollMs?: number;
  /** Hard cap on (re)send attempts. */
  maxAttempts?: number;
  /**
   * Injected surface-state classifier. CLI injects classifyStartupSurface from
   * @squadrant/workspaces. Defaults to () => "idle" (always ready) when omitted.
   */
  classifyScreen?: (screen: string) => StartupSurfaceState;
}

/**
 * #292: deliver the captain/command startup prompt deterministically instead of
 * on a fixed 8s timer. CC cold-init takes 5–15s, so a fixed delay either wastes
 * boot time or — on a slow boot — drops the prompt on the splash screen (#235),
 * leaving the captain idle and the relay unbooted.
 *
 * The loop, per attempt: (1) poll until the surface is past the splash; (2) if a
 * turn is already running, stop — never queue a duplicate startup run; (3) send;
 * (4) after a short settle, re-check — a real submit flips the surface to
 * "working", so we re-send ONLY while it's still "idle" (keystrokes were dropped).
 * Re-sending strictly on observed-still-idle is what guards against duplicate
 * runs: a prompt that landed is never sent twice. Best-effort and never throws.
 */
export async function deliverStartupPrompt(
  runtime: Pick<RuntimeDriver, "readScreen" | "send">,
  refId: string,
  prompt: string,
  opts: StartupDeliveryOptions = {},
): Promise<void> {
  const classify = opts.classifyScreen ?? (() => "idle" as const);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const settleMs = opts.settleMs ?? 2_500;
  const pollMs = opts.pollMs ?? 1_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const read = async () => runtime.readScreen(refId).catch(() => "");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Phase 1 — wait out cold init (poll, don't guess with a fixed delay).
    // Keep the last-read screen as the pre-send baseline for the Phase-3 check.
    const deadline = Date.now() + readyTimeoutMs;
    let preSend = await read();
    let state = classify(preSend);
    while (state === "loading" && Date.now() < deadline) {
      await sleep(pollMs);
      preSend = await read();
      state = classify(preSend);
    }

    // A turn is already in flight (a prior attempt landed, or a resumed session
    // auto-continued). Never keystroke into it — that would queue a duplicate run.
    if (state === "working") return;

    // Phase 2 — deliver. We send on "idle" (input-ready) and, as a non-hanging
    // fallback, on a "loading" timeout (e.g. a non-Claude agent whose chrome we
    // don't recognize) so a launch is never left silently without its prompt.
    await runtime.send(refId, prompt).catch(() => { /* best-effort */ });

    // Timed out waiting for chrome — sent blind once; nothing to confirm, stop.
    if (state === "loading") return;

    // Phase 3 — confirm by whether the surface CHANGED, not by re-matching a
    // working-spinner. The old guard re-sent "while still idle", relying on
    // classifyStartupSurface → CC_WORKING_RE matching the live spinner. The newer
    // CC renders the early turn as a bare "✽ Synthesizing…" (no timer/token/shell
    // marker) and streams "⏺ Thinking…" with no spinner line at all — none of
    // which CC_WORKING_RE matches — so a captain that ALREADY accepted the prompt
    // and is busy thinking reads as "idle" at the +settleMs sample, and the loop
    // re-sends → duplicate startup run (cmux/CC render drift, audit A3; the code
    // is unchanged since v0.6.2). A LANDED prompt always mutates the surface (the
    // submitted message echoes into the transcript and the turn begins); DROPPED
    // keystrokes (#235) leave the surface byte-identical to the pre-send baseline.
    // Re-send only on no-change — robust to whatever the spinner renders as.
    await sleep(settleMs);
    const after = await read();
    if (after !== preSend) return;
  }
}

// ─── bootWorkspace ───────────────────────────────────────────────────────────

export interface BootWorkspaceOpts {
  runtime: RuntimeDriver;
  workspaceName: string;
  agentCmd: string;
  cwd?: string;
  navigate?: boolean;
  forceFresh?: boolean;
  pinToTop?: boolean;
  initialPrompt?: string;
  classifyScreen?: (screen: string) => StartupSurfaceState;
  /** CLI-edge: select/focus a workspace by ID (e.g. cmuxLocal select-workspace). */
  selectWorkspace?: (workspaceId: string) => void;
  /** CLI-edge: return the currently focused workspace ID, or null on error. */
  getCurrentWorkspace?: () => string | null;
  onStoppingStale?: (name: string) => void;
  onAlreadyExists?: (name: string) => void;
  onCreated?: (name: string) => void;
}

/**
 * Spawn (or re-focus) a workspace and deliver the startup prompt.
 * Mirrors the old launchWorkspace implementation but with CLI-edge
 * concerns (cmuxLocal, chalk) injected as callbacks.
 */
export async function bootWorkspace(opts: BootWorkspaceOpts): Promise<void> {
  const {
    runtime, workspaceName, agentCmd, cwd,
    navigate = false, forceFresh = false, pinToTop = false, initialPrompt,
  } = opts;

  const existing = await runtime.status(workspaceName);
  if (existing && forceFresh) {
    opts.onStoppingStale?.(workspaceName);
    await runtime.stop(existing.id);
  } else if (existing) {
    opts.onAlreadyExists?.(workspaceName);
    opts.selectWorkspace?.(existing.id);
    return;
  }

  // Capture current workspace so we can navigate back after spawning.
  // TODO(runtime): current-workspace not yet abstracted on RuntimeDriver.
  const rawCurrent = opts.getCurrentWorkspace?.() ?? null;
  const currentRef = rawCurrent?.match(/workspace:\d+/)?.[0];

  const ref = await runtime.spawn({
    name: workspaceName,
    workdir: cwd ?? process.cwd(),
    command: agentCmd,
    pinToTop,
  });

  if (initialPrompt) {
    // #292: deterministic delivery — poll for input-readiness, send, and bounded
    // re-send if the first turn was dropped (replaces the racy fixed 8s delay
    // that dropped the prompt on slow 5–15s cold boots). Fire-and-forget, as the
    // old setTimeout was, so launch stays non-blocking and `--all` dispatches
    // captains in parallel; the loop's pending poll timers keep the CLI process
    // alive until delivery completes.
    void deliverStartupPrompt(runtime, ref.id, initialPrompt, {
      classifyScreen: opts.classifyScreen,
    });
  }

  // TODO(runtime): select not yet abstracted on RuntimeDriver.
  if (navigate) {
    opts.selectWorkspace?.(ref.id);
  } else if (currentRef) {
    opts.selectWorkspace?.(currentRef);
  }

  opts.onCreated?.(workspaceName);
}

// ─── launchOneWorkspace ──────────────────────────────────────────────────────

export interface LaunchOneOpts {
  workspaceName: string;
  role: string;
  cwd: string;
  /** Honour the --fresh CLI flag when true. */
  forceFreshOverride?: boolean;
  /**
   * Honour the --keep CLI flag when true: suppress the "new day" and
   * "template instructions updated" auto-fresh reasons so the session
   * resumes. Never suppresses "first launch" — there is no session to
   * resume yet.
   */
  keepOverride?: boolean;
  sessionsPath: string;
  templatesDir: string;
  /**
   * CLI-edge factory: called with the resolved forceFresh flag so the CLI can
   * pass it through to buildAgentCmd (from @squadrant/agents, unavailable here).
   */
  agentCmdFactory: (forceFresh: boolean) => string;
  initialPrompt?: string;
  runtime: RuntimeDriver;
  navigate?: boolean;
  pinToTop?: boolean;
  classifyScreen?: (screen: string) => StartupSurfaceState;
  selectWorkspace?: (workspaceId: string) => void;
  getCurrentWorkspace?: () => string | null;
  onFreshReason?: (reason: string) => void;
  onStoppingStale?: (name: string) => void;
  onAlreadyExists?: (name: string) => void;
  onCreated?: (name: string) => void;
}

/**
 * Full workspace-boot orchestration: fresh-session check → recordSession →
 * agentCmd build → bootWorkspace (spawn + prompt delivery).
 *
 * Mirrors the old launchOne inner function with driver construction and
 * chalk output extracted to injectable callbacks.
 */
export async function launchOneWorkspace(opts: LaunchOneOpts): Promise<void> {
  let forceFresh = !!opts.forceFreshOverride;
  if (!forceFresh) {
    const auto = shouldStartFresh(opts.workspaceName, opts.role, {
      sessionsPath: opts.sessionsPath,
      templatesDir: opts.templatesDir,
    });
    if (auto.fresh && opts.keepOverride && auto.reason !== "first launch") {
      opts.onFreshReason?.(`keeping previous session (--keep) despite: ${auto.reason}`);
    } else if (auto.fresh) {
      opts.onFreshReason?.(auto.reason ?? "starting fresh");
      forceFresh = true;
    }
  }

  const agentCmd = opts.agentCmdFactory(forceFresh);
  recordSession(opts.workspaceName, opts.role, {
    sessionsPath: opts.sessionsPath,
    templatesDir: opts.templatesDir,
  });

  await bootWorkspace({
    runtime: opts.runtime,
    workspaceName: opts.workspaceName,
    agentCmd,
    cwd: opts.cwd,
    navigate: opts.navigate,
    forceFresh,
    pinToTop: opts.pinToTop,
    initialPrompt: opts.initialPrompt,
    classifyScreen: opts.classifyScreen,
    selectWorkspace: opts.selectWorkspace,
    getCurrentWorkspace: opts.getCurrentWorkspace,
    onStoppingStale: opts.onStoppingStale,
    onAlreadyExists: opts.onAlreadyExists,
    onCreated: opts.onCreated,
  });
}
