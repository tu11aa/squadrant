// captain-restart.ts — #1137: `squadrant captain restart <project>`.
//
// `launch <project> --fresh` closes the captain workspace first, so run from the
// captain's own pane it kills itself half-way. `captain restart` instead spawns a
// DETACHED helper (own session via setsid, stdio to a log file, parent exits at
// once) that outlives the workspace. The helper waits until the captain's turn
// has ended and no prompt is open, runs `launch <project> --fresh --headless`,
// and exits. No daemon code is involved, so any running daemon version works.
//
// Idle = BOTH of, for RESTART_IDLE_POLLS consecutive polls:
//  - cmux's hook store (~/.cmuxterm/claude-hook-sessions.json, written by cmux's
//    own Claude hooks) reports the turn of the session active on the captain's
//    surface as over: agentLifecycle "idle" (Stop fired) or "backgroundWorkPending"
//    — not "running" or "needsInput" (a permission/question prompt). Keyed by the
//    surface (activeSessionsBySurface), so it follows the live session.
//  - the captain pane reads idle the same way `captain compact` checks it: no
//    working spinner, no option modal, an empty input box (a draft is someone
//    typing; closing would throw it away).
// A surface with no hook-store record falls back to the pane check alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { CC_WORKING_RE, discoverCaptainSurface } from "@squadrant/core";
import { hasModalOptionList, parseDraftFromScreen } from "@squadrant/workspaces";
import type { RuntimeDriver, PaneRef } from "@squadrant/shared";

export const RESTART_TIMEOUT_MS = 10 * 60_000;
export const RESTART_POLL_MS = 1_000;
/** Consecutive idle polls before closing — rides out a flicker between tool calls. */
export const RESTART_IDLE_POLLS = 3;

export function restartPaths(stateRoot: string, project: string): { lock: string; log: string } {
  const dir = path.join(stateRoot, project);
  return { lock: path.join(dir, "captain-restart.lock"), log: path.join(dir, "captain-restart.log") };
}

// ─── one pending restart per project ─────────────────────────────────────────

export interface RestartLock { pid: number; startedAt: string; log: string }

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readRestartLock(lockPath: string): RestartLock | null {
  try {
    const v = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as RestartLock;
    return typeof v?.pid === "number" ? v : null;
  } catch { return null; }
}

/** Take the project's restart lock, or return the live holder. A lock whose pid is dead is stale and replaced. */
export function acquireRestartLock(
  lockPath: string,
  lock: RestartLock,
  alive: (pid: number) => boolean = isPidAlive,
): { ok: true } | { ok: false; holder: RestartLock } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readRestartLock(lockPath);
    if (holder && alive(holder.pid)) return { ok: false, holder };
    fs.rmSync(lockPath, { force: true });
  }
  throw new Error(`could not take the restart lock ${lockPath}`);
}

/** Remove the lock only if `pid` still owns it. */
export function releaseRestartLock(lockPath: string, pid: number): void {
  if (readRestartLock(lockPath)?.pid === pid) fs.rmSync(lockPath, { force: true });
}

// ─── is it idle ──────────────────────────────────────────────────────────────

export interface HookState { sessionId: string; lifecycle?: string }

/** Pure. The session cmux has active on a surface (by surface UUID) and its agentLifecycle. */
export function surfaceHookState(store: unknown, surfaceUuid: string): HookState | undefined {
  const s = store as {
    activeSessionsBySurface?: Record<string, { sessionId?: unknown }>;
    sessions?: Record<string, { agentLifecycle?: unknown }>;
  } | null;
  const sessionId = s?.activeSessionsBySurface?.[surfaceUuid]?.sessionId;
  if (typeof sessionId !== "string") return undefined;
  const lifecycle = s?.sessions?.[sessionId]?.agentLifecycle;
  return { sessionId, ...(typeof lifecycle === "string" ? { lifecycle } : {}) };
}

export function readCmuxHookStore(
  stateDir: string = process.env.CMUX_AGENT_HOOK_STATE_DIR ?? path.join(os.homedir(), ".cmuxterm"),
): unknown {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, "claude-hook-sessions.json"), "utf-8")); } catch { return null; }
}

/** Pure. A surface ref's UUID from `cmux tree --json --id-format both` output. */
export function surfaceUuidFromTree(treeJson: string, surfaceRef: string): string | undefined {
  try {
    const tree = JSON.parse(treeJson) as {
      windows?: Array<{ workspaces?: Array<{ panes?: Array<{ surfaces?: Array<{ ref?: string; id?: string }> }> }> }>;
    };
    return tree.windows
      ?.flatMap((w) => w.workspaces ?? [])
      .flatMap((w) => w.panes ?? [])
      .flatMap((p) => p.surfaces ?? [])
      .find((s) => s.ref === surfaceRef)?.id;
  } catch { return undefined; }
}

export type IdleVerdict = { idle: true } | { idle: false; reason: string };

/** Pure. `inputState` is cmux >= 0.65's surface.input_state (undefined when unavailable). */
export function captainIdleVerdict(o: { lifecycle?: string; screen: string | null; inputState?: string }): IdleVerdict {
  if (o.lifecycle !== undefined && o.lifecycle !== "idle" && o.lifecycle !== "backgroundWorkPending") {
    return { idle: false, reason: `hook:${o.lifecycle}` };
  }
  const screen = o.screen;
  if (!screen) return { idle: false, reason: "unreadable" };
  if (CC_WORKING_RE.test(screen)) return { idle: false, reason: "turn-in-flight" };
  if (o.inputState === "dialog" || hasModalOptionList(screen)) return { idle: false, reason: "prompt-open" };
  if (o.inputState === "draft") return { idle: false, reason: "draft" };
  if (o.inputState !== "empty") {
    const draft = parseDraftFromScreen(screen);
    if (draft === null) return { idle: false, reason: "no-box" };
    if (draft !== "") return { idle: false, reason: "draft" };
  }
  return { idle: true };
}

// ─── the detached helper ─────────────────────────────────────────────────────

export interface RestartHelperDeps {
  project: string;
  captainName: string;
  runtime: Pick<RuntimeDriver, "status" | "listSurfaces" | "readPaneScreen" | "inputState">;
  /** cmux hook-store state of the session on the captain's pane; undefined when there is none. */
  hookState: (pane: PaneRef) => Promise<HookState | undefined>;
  /** Runs `launch <project> --fresh --headless`; resolves its exit code. */
  launchFresh: () => Promise<number>;
  /** Switch to the new captain workspace (--focus). */
  focus?: (workspaceId: string) => void;
  /** Tell the captain and the operator (best-effort). */
  notify: (text: string) => Promise<void>;
  log: (line: string) => void;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type RestartOutcome = "restarted" | "gave-up" | "launch-failed";

export async function runRestartHelper(d: RestartHelperDeps): Promise<RestartOutcome> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = d.timeoutMs ?? RESTART_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  d.log(`waiting for captain '${d.captainName}' to go idle`);

  let idlePolls = 0;
  let lastReason = "";
  let lastSession: string | undefined | null = null;
  for (;;) {
    const verdict = await pollOnce(d, (s) => {
      if (s?.sessionId === lastSession) return;
      lastSession = s?.sessionId;
      d.log(s ? `captain session ${s.sessionId} (hook store + pane)` : "no hook-store record for the captain pane — pane check only");
    }).catch((e: unknown): IdleVerdict => ({ idle: false, reason: `error: ${(e as Error).message}` }));
    if (verdict.idle) {
      if (++idlePolls >= RESTART_IDLE_POLLS) break;
    } else {
      idlePolls = 0;
      if (verdict.reason !== lastReason) d.log(`not idle: ${verdict.reason}`);
      lastReason = verdict.reason;
    }
    if (now() >= deadline) {
      const waited = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)}s`;
      const text = `captain restart ${d.project}: gave up after ${waited} — the captain never went idle (last: ${lastReason || "busy"}). Nothing was restarted; end the turn and run \`squadrant captain restart ${d.project}\` again.`;
      d.log(text);
      await d.notify(text);
      return "gave-up";
    }
    await sleep(d.pollMs ?? RESTART_POLL_MS);
  }

  d.log("captain idle — running launch --fresh");
  const code = await d.launchFresh();
  if (code !== 0) {
    const text = `captain restart ${d.project}: \`squadrant launch ${d.project} --fresh\` exited ${code} — check the restart log and relaunch by hand.`;
    d.log(text);
    await d.notify(text);
    return "launch-failed";
  }
  const ws = await d.runtime.status(d.captainName);
  d.log(ws ? `fresh captain up in ${ws.id}` : "launch exited 0 but no captain workspace is listed");
  if (ws && d.focus) {
    try { d.focus(ws.id); } catch (e) { d.log(`focus failed: ${(e as Error).message}`); }
  }
  return "restarted";
}

async function pollOnce(d: RestartHelperDeps, seen: (s: HookState | undefined) => void): Promise<IdleVerdict> {
  // A missing workspace may be a cmux read error (list() swallows them): never
  // treat it as "gone" — a launch then would add a second captain next to the old one.
  const ws = await d.runtime.status(d.captainName);
  if (!ws) return { idle: false, reason: "no-workspace" };
  const pane = discoverCaptainSurface(await d.runtime.listSurfaces(ws.id), d.captainName);
  if (!pane) return { idle: false, reason: "no-surface" };
  const screen = await d.runtime.readPaneScreen(pane);
  const inputState = await d.runtime.inputState?.(pane);
  const hook = await d.hookState(pane);
  seen(hook);
  return captainIdleVerdict({ lifecycle: hook?.lifecycle, screen, inputState });
}

// ─── spawning it ─────────────────────────────────────────────────────────────

/** Env naming the captain's own pane/session. The pane is about to close, so the
 *  helper and its `launch` child must not target it (e.g. `cmux current-workspace`). */
const PANE_ENV = [
  "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_PANEL_ID", "CMUX_TAB_ID", "CMUX_CLAUDE_PID",
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

export function helperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of PANE_ENV) delete out[k];
  return out;
}

export interface StartRestartOpts {
  project: string;
  stateRoot: string;
  /** The squadrant CLI entry (process.argv[1]). */
  cliPath: string;
  focus?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  alive?: (pid: number) => boolean;
}

export type StartRestartResult =
  | { status: "started"; pid: number; log: string }
  | { status: "pending"; holder: RestartLock };

/** Take the lock and spawn the detached helper; returns at once. */
export function startCaptainRestart(o: StartRestartOpts): StartRestartResult {
  const { lock, log } = restartPaths(o.stateRoot, o.project);
  const startedAt = new Date().toISOString();
  const got = acquireRestartLock(lock, { pid: process.pid, startedAt, log }, o.alive);
  if (!got.ok) return { status: "pending", holder: got.holder };

  try {
    const fd = fs.openSync(log, "a");
    fs.writeSync(fd, `\n[${startedAt}] captain restart ${o.project} requested\n`);
    const args = [o.cliPath, "captain", "restart-run", o.project];
    if (o.focus) args.push("--focus");
    if (o.timeoutMs !== undefined) args.push("--timeout-ms", String(o.timeoutMs));
    const child = (o.spawn ?? nodeSpawn)(process.execPath, args, {
      detached: true, // own session: closing the captain's terminal does not reach it
      stdio: ["ignore", fd, fd],
      env: helperEnv(o.env ?? process.env),
    });
    child.unref();
    fs.closeSync(fd);
    if (!child.pid) throw new Error("the restart helper did not start");
    fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt, log }));
    return { status: "started", pid: child.pid, log };
  } catch (e) {
    releaseRestartLock(lock, process.pid);
    throw e;
  }
}
