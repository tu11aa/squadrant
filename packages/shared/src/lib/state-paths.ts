// src/lib/state-paths.ts
//
// #983 6a (KB spec K7/§4/§10): squadrant runtime state lives in XDG state,
// not ~/.config. One resolver for every caller — daemon, CLI, web — so the
// state root can never drift between processes again. Agent-agnostic.
//
// Env is read at call time (not import time) so tests and harnesses can
// redirect it per process.
import { cpSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const defaultConfigDir = () => join(homedir(), ".config", "squadrant");

/** SQUADRANT_CONFIG when it points somewhere other than the default config. */
export function isolatedConfigDir(): string | null {
  const cfg = process.env.SQUADRANT_CONFIG;
  if (!cfg || resolve(cfg) === join(defaultConfigDir(), "config.json")) return null;
  return dirname(resolve(cfg));
}

/**
 * #1046: an isolated daemon's own claude settings file, used in place of the
 * user's global ~/.claude/settings.json (which only the production daemon
 * manages). null for the default config.
 */
export function isolatedClaudeSettingsPath(): string | null {
  const dir = isolatedConfigDir();
  return dir ? join(dir, "claude-settings.json") : null;
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * #1046: env assignment (`SQUADRANT_CONFIG='<abs>' `) a session spawned under
 * an isolated config needs so its hooks, MCP server and signal verbs reach the
 * isolated daemon. "" for the default config.
 */
export function isolatedSessionEnvPrefix(): string {
  if (!isolatedConfigDir()) return "";
  return `SQUADRANT_CONFIG=${shq(resolve(process.env.SQUADRANT_CONFIG!))} `;
}

/**
 * #1046: claude flags for a session spawned under an isolated config — drop
 * the user settings source (production hooks) and load the isolated file
 * instead. Project/local sources stay. "" for the default config.
 */
export function isolatedClaudeFlags(): string {
  const settingsPath = isolatedClaudeSettingsPath();
  return settingsPath ? ` --setting-sources project,local --settings ${shq(settingsPath)}` : "";
}

/**
 * Root of squadrant's runtime state (task store, mailboxes, results, liveness,
 * knowledge schedule, rules-inject seen-set, sessions.json). Precedence:
 *   1. $SQUADRANT_STATE_DIR
 *   2. dirname($SQUADRANT_CONFIG)/state — only for a NON-default config path,
 *      so isolated harnesses never write into the operator's live state
 *   3. $XDG_STATE_HOME/squadrant
 *   4. ~/.local/state/squadrant
 */
export function stateRoot(): string {
  if (process.env.SQUADRANT_STATE_DIR) return process.env.SQUADRANT_STATE_DIR;
  const isolated = isolatedConfigDir();
  if (isolated) return join(isolated, "state");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "squadrant");
}

/** Daemon log directory; follows stateRoot(). */
export function logsRoot(): string {
  return join(stateRoot(), "logs");
}

/** The launchd-managed daemon log file. */
export function daemonLogPath(): string {
  return join(logsRoot(), "squadrantd.log");
}

/** Captain session freshness records (launch). */
export function sessionsPath(): string {
  return join(stateRoot(), "sessions.json");
}

/** Pre-#983 state dir (~/.config/squadrant/state, or beside an isolated config).
 *  Read-only fallback for one version; `squadrant migrate kb` archives it. */
export function legacyStateDir(): string {
  return join(isolatedConfigDir() ?? defaultConfigDir(), "state");
}

/** Pre-#983 daemon log, still written by launchd until the plist is reloaded. */
export function legacyDaemonLogPath(): string {
  return join(isolatedConfigDir() ?? defaultConfigDir(), "squadrantd.log");
}

/** Pre-#983 sessions.json location. */
export function legacySessionsPath(): string {
  return join(isolatedConfigDir() ?? defaultConfigDir(), "sessions.json");
}

/** Top-level stateRoot() entries a project dir (stateRoot()/<project>) must
 *  never shadow — the flat layout shares one namespace. */
const RESERVED_STATE_NAMES = new Set(["audit", "logs", "inbox", "rules-inject"]);

/** Error text when `name` can't be a project name under the flat state layout, else null. */
export function reservedStateNameError(name: string): string | null {
  if (!RESERVED_STATE_NAMES.has(name) && !/^[_.]/.test(name)) return null;
  return `project name '${name}' is reserved: it would collide with ${join(stateRoot(), name)} ` +
    `(reserved: ${[...RESERVED_STATE_NAMES].join(", ")}, and names starting with '_' or '.')`;
}

/** Written once the legacy state has been copied into the new root. */
export function stateSeedMarkerPath(root: string = stateRoot()): string {
  return join(root, ".seeded-from-legacy");
}

/** Single-file dual-read: the new path when it exists, else the legacy path
 *  when that exists, else the new path (where writes go). */
export function resolveReadPath(newPath: string, legacyPath: string): string {
  if (existsSync(newPath) || !existsSync(legacyPath)) return newPath;
  return legacyPath;
}

export interface SeedResult {
  seeded: boolean;
  reason: "seeded" | "same-dir" | "already-seeded" | "no-legacy-data";
}

/**
 * One-time dual-read for the directory-shaped daemon state: copy the legacy
 * tree into the new root without overwriting anything already there, then
 * write the marker. Never deletes. Idempotent — the marker stops a re-copy
 * from resurrecting mailbox entries or records the daemon has since consumed.
 * Daemon-boot only: a CLI-side copy could race an old daemon still writing
 * the legacy dir.
 */
export function seedStateFromLegacy(opts: { root?: string; legacy?: string } = {}): SeedResult {
  const root = opts.root ?? stateRoot();
  const legacy = opts.legacy ?? legacyStateDir();
  if (resolve(root) === resolve(legacy)) return { seeded: false, reason: "same-dir" };
  const marker = stateSeedMarkerPath(root);
  if (existsSync(marker)) return { seeded: false, reason: "already-seeded" };
  if (!existsSync(legacy) || readdirSync(legacy).length === 0) return { seeded: false, reason: "no-legacy-data" };
  mkdirSync(root, { recursive: true });
  cpSync(legacy, root, { recursive: true, force: false, errorOnExist: false });
  writeFileSync(marker, JSON.stringify({ from: legacy, at: new Date().toISOString() }) + "\n");
  return { seeded: true, reason: "seeded" };
}
