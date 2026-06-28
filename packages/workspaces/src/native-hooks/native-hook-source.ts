// native-hook-source.ts — LifecycleSource C: squadrant-owned claude hooks
//
// PRIMARY LifecycleSource (#333 Phase 1, D1). Installs namespaced hooks into
// claude's native config and receives hook events pushed by the daemon.
//
// NOT wired into the live daemon in Phase 1 (additive per D3/D7).
// The sibling wiring crew adds 'squadrant hooks claude <sub>' to the CLI,
// reads SQUADRANT_CREW_TASK_ID from the hook process env, and calls handleHook().

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot, LifecycleState } from "@squadrant/core";

// ── Hook event matrix ─────────────────────────────────────────────────────────

// Claude hook event name → sub-command alias → optional tool matcher (blueprint §9).
// Non-lifecycle hooks (PostToolUse, SubagentStop) are intentionally excluded;
// they feed the existing crew._hook bridge and are not part of the 4-state model.
//
// Third element (matcher) is passed as the hook entry's "matcher" field.
// AskUserQuestion is a TOOL, not an event — hook it via PreToolUse with a tool matcher.
const CLAUDE_HOOK_EVENTS: ReadonlyArray<readonly [string, string, string?]> = [
  ["SessionStart",     "session-start"],
  ["UserPromptSubmit", "prompt-submit"],
  ["PreToolUse",       "pre-tool-use"],
  ["Stop",             "stop"],
  ["Notification",     "notification"],
  ["PreToolUse",       "ask-question", "AskUserQuestion"],
  ["SessionEnd",       "session-end"],
];

const DEFAULT_HOOK_CMD = "squadrant hooks";

// ── Hook installer ────────────────────────────────────────────────────────────

export interface ClaudeHooksInstallOpts {
  /** Path to ~/.claude/settings.json. Injectable for tests. */
  settingsPath?: string;
  /**
   * Base hook command — final command is '<hookCmd> claude <sub>'.
   * Default: 'squadrant hooks' (the CLI subcommand wired by the daemon crew).
   */
  hookCmd?: string;
  /** Injectable: read file content, undefined on any read error. */
  readFile?: (path: string) => string | undefined;
  /** Injectable: write file (caller responsible for creating parent dirs). */
  writeFile?: (path: string, content: string) => void;
  log?: (msg: string) => void;
}

/**
 * Idempotent, non-clobbering installer for squadrant-owned hooks in ~/.claude/settings.json.
 *
 * Installs one hook entry per lifecycle-relevant Claude hook event (D4: namespaced,
 * re-run-safe). Hooks from cmux, the user, or other tools with different commands
 * are left untouched. A second call with the same hookCmd is a complete no-op.
 * Returns the path to the settings file (which may or may not have been written).
 */
export function installClaudeHooks(opts: ClaudeHooksInstallOpts = {}): string {
  const settingsPath = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const hookCmd = opts.hookCmd ?? DEFAULT_HOOK_CMD;
  const readFile = opts.readFile ?? defaultReadFile;
  const writeFile = opts.writeFile ?? defaultWriteFile;
  const log = opts.log ?? (() => {});

  // Parse existing settings (start fresh if absent or malformed).
  let settings: Record<string, unknown> = {};
  const raw = readFile(settingsPath);
  if (raw) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log(`native-hook: failed to parse ${settingsPath} — hooks section will be reset`);
    }
  }

  // Ensure hooks is a plain object.
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;

  let changed = false;
  for (const [eventName, sub, matcher] of CLAUDE_HOOK_EVENTS) {
    if (!Array.isArray(hooks[eventName])) {
      hooks[eventName] = [];
    }
    const entries = hooks[eventName] as unknown[];
    const command = `${hookCmd} claude ${sub}`;
    const hookMatcher = matcher ?? "";

    // Idempotency check: skip if our exact command is already registered.
    const alreadyPresent = entries.some(
      (m) =>
        Array.isArray((m as Record<string, unknown>).hooks) &&
        ((m as Record<string, unknown>).hooks as unknown[]).some(
          (h) =>
            typeof (h as Record<string, unknown>).command === "string" &&
            (h as Record<string, unknown>).command === command,
        ),
    );
    if (!alreadyPresent) {
      entries.push({ matcher: hookMatcher, hooks: [{ type: "command", command, timeout: 10 }] });
      changed = true;
    }
  }

  if (changed) {
    writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }
  return settingsPath;
}

// ── Sub-event → lifecycle state mapping ──────────────────────────────────────

/**
 * Pure: map a sub-event alias to its LifecycleState.
 * Returns "session-end" for the teardown alias (not a LifecycleState value — the
 * caller emits alive:false + state:"unknown" and the daemon wiring translates to
 * task.session.ended). Returns null for unknown subs (caller no-ops).
 */
export function mapSubToLifecycle(sub: string): LifecycleState | "session-end" | null {
  switch (sub) {
    case "session-start":  return "running";
    case "prompt-submit":  return "running";
    case "pre-tool-use":   return "running";
    case "stop":           return "idle";
    case "notification":   return "needsInput";
    case "ask-question":   return "needsInput";
    case "session-end":    return "session-end";
    default:               return null;
  }
}

// ── NativeHookSource ─────────────────────────────────────────────────────────

export interface NativeHookSourceOpts {
  /** Options forwarded to installClaudeHooks(). Useful for testing. */
  hookInstall?: ClaudeHooksInstallOpts;
  log?: (msg: string) => void;
}

/**
 * LifecycleSource C — primary, driver-agnostic (#333 D1).
 *
 * Two seams:
 *   1. install() — writes squadrant-owned hooks into ~/.claude/settings.json
 *      (idempotent, namespaced, non-clobbering per D4).
 *   2. handleHook(sub, taskId, pid?, payload?) — called by the daemon when a
 *      claude hook fires; maps the sub-event to a LifecycleSnapshot and feeds
 *      it into deps.report().
 *
 * Unlike CmuxStoreSource (file-watcher), NativeHookSource is purely push-driven:
 * every snapshot arrives via handleHook() from the daemon's 'squadrant hooks'
 * CLI subcommand. The snapshot() method serves the liveness floor from the cache.
 */
export class NativeHookSource implements LifecycleSource {
  readonly name = "native-hook";

  private readonly hookInstall: ClaudeHooksInstallOpts;
  private readonly log: (msg: string) => void;

  private deps?: LifecycleSourceDeps;
  /** taskId → last-reported snapshot, for snapshot() liveness floor. */
  private cache = new Map<string, LifecycleSnapshot>();

  constructor(opts: NativeHookSourceOpts = {}) {
    this.hookInstall = opts.hookInstall ?? {};
    this.log = opts.log ?? (() => {});
  }

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
  }

  stop(): void {
    this.deps = undefined;
    this.cache.clear();
  }

  /** Returns the last-reported snapshot for a known crew (liveness floor poll). */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    return this.cache.get(taskId);
  }

  /**
   * Install squadrant-owned hooks into ~/.claude/settings.json.
   * Idempotent — safe to call on every project init or crew spawn.
   * Returns the path to the settings file.
   */
  install(): string {
    return installClaudeHooks(this.hookInstall);
  }

  /**
   * Receive a lifecycle hook event from the daemon and report a LifecycleSnapshot.
   *
   * The daemon's 'squadrant hooks claude <sub>' CLI subcommand calls this after
   * reading SQUADRANT_CREW_TASK_ID from the hook's process environment — the only
   * collision-proof correlation key (blueprint §2.2 priority 1).
   *
   * @param sub     Sub-event alias: "session-start" | "prompt-submit" | "stop" | …
   * @param taskId  SQUADRANT_CREW_TASK_ID extracted from the hook process env.
   * @param pid     Optional: OS pid from the hook's process env or argv.
   * @param payload Optional: parsed JSON payload from hook stdin (best-effort detail).
   */
  handleHook(sub: string, taskId: string, pid?: number, payload?: unknown): void {
    if (!this.deps) return;

    const mapped = mapSubToLifecycle(sub);
    if (mapped === null) {
      this.log(`native-hook: unknown sub '${sub}' for task ${taskId} — ignored`);
      return;
    }

    // session-end signals teardown: alive:false lets the daemon wiring emit
    // task.session.ended (anti-#2576: never task.done from a lifecycle hook).
    const isSessionEnd = mapped === "session-end";
    const state: LifecycleState = isSessionEnd ? "unknown" : mapped;

    const detail = extractDetail(sub, payload);
    const snap: LifecycleSnapshot = {
      taskId,
      state,
      alive: !isSessionEnd,
      origin: "agent",
      at: Date.now(),
      ...(pid !== undefined ? { pid } : {}),
      ...(detail ? { detail } : {}),
    };

    this.cache.set(taskId, snap);
    this.deps.report(snap);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function extractDetail(sub: string, payload: unknown): LifecycleSnapshot["detail"] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (sub === "notification") {
    const note = typeof p.message === "string" ? p.message : undefined;
    return note ? { note } : undefined;
  }
  if (sub === "pre-tool-use") {
    const tool = typeof p.tool_name === "string" ? p.tool_name : undefined;
    return tool ? { tool } : undefined;
  }
  return undefined;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function defaultWriteFile(path: string, content: string): void {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, content, "utf-8");
}
