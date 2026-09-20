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
  // #760: fires ~6s before the matching Notification, carrying tool_name +
  // tool_input directly — a strictly better task.blocked source.
  ["PermissionRequest", "permission-request"],
  // #763: the turn died on an API error — today squadrant has no source for
  // this at all; without it the watchdog reports a plain stall (wrong story).
  ["StopFailure", "stop-failure"],
];

const DEFAULT_HOOK_CMD = "squadrant hooks";

/**
 * #782: the PermissionRequest event is owned by the U7 permission gate — a
 * first-class CLI path that classifies with the configured router model (no
 * Anthropic credential). It is installed as its own command so the gate — not
 * the lifecycle hook bridge — is what Claude invokes at the prompt. The legacy
 * `squadrant hooks claude permission-request` entry is migrated out (see
 * installClaudeHooks) so a prompt is never processed twice.
 */
const GATE_HOOK_CMD = "squadrant gate";

/** The managed command for one event. PermissionRequest is gate-owned (#782). */
function hookCommandFor(eventName: string, sub: string, hookCmd: string): string {
  return eventName === "PermissionRequest"
    ? `${GATE_HOOK_CMD} claude ${sub}`
    : `${hookCmd} claude ${sub}`;
}

/**
 * Remove every handler whose `command` exactly matches `command` from a hook
 * event's entry list. Drops entries left with no handlers. Returns true if
 * anything was removed. Used to migrate the pre-#782 PermissionRequest command.
 */
function removeCommandHandlers(entries: unknown[], command: string): boolean {
  let removed = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { hooks?: unknown[] };
    if (!Array.isArray(entry?.hooks)) continue;
    const before = entry.hooks.length;
    entry.hooks = entry.hooks.filter(
      (h) => (h as { command?: unknown })?.command !== command,
    );
    if (entry.hooks.length !== before) removed = true;
    if (entry.hooks.length === 0) entries.splice(i, 1);
  }
  return removed;
}

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
  /**
   * #615 opt-in: deep-merged into settings.json's 'env' block, non-clobbering —
   * a key already present in the user's settings is never overwritten (logged
   * instead). Absent or empty ⇒ nothing written to env. Sourced from
   * squadrant config's defaults.claudeEnv.
   */
  claudeEnv?: Record<string, string>;
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
  const hadExistingSettings = raw !== undefined;
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
  const repaired: string[] = [];
  const migrated: string[] = [];
  for (const [eventName, sub, matcher] of CLAUDE_HOOK_EVENTS) {
    if (!Array.isArray(hooks[eventName])) {
      hooks[eventName] = [];
    }
    const entries = hooks[eventName] as unknown[];
    const command = hookCommandFor(eventName, sub, hookCmd);
    const hookMatcher = matcher ?? "";

    // #782: migrate the legacy PermissionRequest handler (which the gate now
    // supersedes) out of the settings file. Only when it differs from the
    // desired command, so a hookCmd that already IS the gate is a no-op.
    if (eventName === "PermissionRequest") {
      const legacy = `${hookCmd} claude ${sub}`;
      if (legacy !== command && removeCommandHandlers(entries, legacy)) {
        changed = true;
        migrated.push(`${eventName}/${sub}`);
      }
    }

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
      repaired.push(`${eventName}/${sub}`);
    }
  }

  // #615: a hook missing from an already-existing settings file is drift (e.g. the
  // file was hand-edited or clobbered) — surface it, since a missing AskUserQuestion
  // hook silently kills crew-blocked signalling (#560). A fresh install where nothing
  // existed yet is not drift, so it stays quiet.
  if (repaired.length > 0 && hadExistingSettings) {
    log(
      `native-hook: repaired ${repaired.length} missing squadrant hook(s) in ${settingsPath} [${repaired.join(", ")}] — WARNING: blocked-signalling or lifecycle tracking may have been broken until this run`,
    );
  }

  // #782: one-line note when the legacy PermissionRequest hook was replaced by
  // the permission gate. Informational — the migration itself is safe.
  if (migrated.length > 0) {
    log(
      `native-hook: migrated ${migrated.length} PermissionRequest hook(s) to the U7 permission gate in ${settingsPath} [${migrated.join(", ")}]`,
    );
  }

  // #615 opt-in: deep-merge defaults.claudeEnv into settings.json 'env', non-clobbering.
  if (opts.claudeEnv && Object.keys(opts.claudeEnv).length > 0) {
    if (typeof settings.env !== "object" || settings.env === null || Array.isArray(settings.env)) {
      settings.env = {};
    }
    const env = settings.env as Record<string, unknown>;
    for (const [key, value] of Object.entries(opts.claudeEnv)) {
      if (key in env) {
        if (env[key] !== value) {
          log(
            `native-hook: claudeEnv key '${key}' already set to '${String(env[key])}' in ${settingsPath} — not overwriting with '${value}'`,
          );
        }
        continue;
      }
      env[key] = value;
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
    case "permission-request": return "needsInput";
    case "stop-failure":  return "idle";
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
 *
 * DEFERRED (2026-08-29): the LifecycleSource half of this class is INERT.
 * handleHook() — the only method that populates `cache` and calls deps.report()
 * — has no caller in shipped code; every reference is in this package's own
 * tests. snapshot() therefore always returns undefined and this source
 * contributes zero lifecycle signals. install() is real and load-bearing (#615).
 * The live claude hook path is: `squadrant hooks claude <sub>` → mapHookSub()
 * → socket → applyEvent. Kept as-is by operator decision; do not delete or
 * wire up without revisiting docs/specs/2026-08-29-event-architecture-design.md.
 */
export class NativeHookSource implements LifecycleSource {
  readonly name = "native-hook";

  private readonly hookInstall: ClaudeHooksInstallOpts;
  private readonly log: (msg: string) => void;

  private deps?: LifecycleSourceDeps;
  /** taskId → last-reported snapshot, for snapshot() liveness floor. */
  private cache = new Map<string, LifecycleSnapshot>();
  private active = false;

  constructor(opts: NativeHookSourceOpts = {}) {
    this.log = opts.log ?? (() => {});
    // Forward the source-level log into installClaudeHooks by default so #615
    // repair/non-clobber warnings surface — an explicit hookInstall.log still wins.
    this.hookInstall = { log: this.log, ...opts.hookInstall };
  }

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
    this.active = true;
  }

  stop(): void {
    this.deps = undefined;
    this.cache.clear();
    this.active = false;
  }

  /** Returns the last-reported snapshot for a known crew (liveness floor poll). */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    return this.cache.get(taskId);
  }

  /** Read-only source health (B4). Purely push-driven — never errors on its own. */
  health(): { active: boolean; error: string | null } {
    return { active: this.active, error: null };
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
