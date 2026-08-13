// src/control/launchd.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync, unlinkSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.squadrant.daemon";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/**
 * Canonical path to the compiled daemon entrypoint, resolved relative to THIS
 * module (squadrantd.js is a sibling of the bundled entry in <dist>/). This is
 * the single source of truth — callers must NOT recompute it (a hardcoded
 * ~/.config/squadrant/dist path crash-loops the agent with MODULE_NOT_FOUND
 * because runtime-sync never mirrors compiled output there).
 */
export function daemonEntryPath(): string {
  const p = join(dirname(fileURLToPath(import.meta.url)), "squadrantd.js");
  if (!existsSync(p)) {
    throw new Error(
      `daemonEntryPath: compiled entry not found at '${p}'; ` +
      `run 'npm run build' — a src-tree or missing path in the launchd plist causes a MODULE_NOT_FOUND crash-loop (#259)`,
    );
  }
  return p;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Extract the [nodeBin, daemonEntry] pair from a plist's ProgramArguments
 * array (the exact shape renderPlist emits). Returns null for anything that
 * doesn't match — a missing key, a hand-edited plist, or garbage.
 */
export function parseProgramArgs(plistXml: string): { nodeBin: string; daemonEntry: string } | null {
  const m = plistXml.match(/<key>ProgramArguments<\/key>\s*<array><string>([^<]*)<\/string><string>([^<]*)<\/string><\/array>/);
  if (!m) return null;
  return { nodeBin: xmlUnescape(m[1]), daemonEntry: xmlUnescape(m[2]) };
}

export interface ForeignInstall {
  /** The squadrantd.js path currently registered in the on-disk plist. */
  registeredEntry: string;
  /** This process's own daemonEntryPath(). */
  thisEntry: string;
}

/**
 * #670: two different squadrant installs (e.g. an accidental pnpm + npm
 * duplicate) each resolve their OWN daemonEntryPath() and, absent this
 * check, will happily overwrite each other's plist registration — the
 * flip-flop that caused the production crash-loop. A registered entry only
 * counts as "foreign" (unsafe to overwrite) when it differs from this
 * install's own entry AND the file it points at still exists; a registered
 * entry that's gone is stale and safe to reclaim (existing behavior).
 */
export function detectForeignInstall(
  parsed: { daemonEntry: string } | null,
  thisEntry: string,
  registeredEntryExists: boolean,
): ForeignInstall | null {
  if (!parsed) return null;
  if (parsed.daemonEntry === thisEntry) return null;
  if (!registeredEntryExists) return null;
  return { registeredEntry: parsed.daemonEntry, thisEntry };
}

/**
 * Strip per-shell ephemeral PATH entries (Claude Code plugin cache dirs) and
 * dedupe so the plist content is stable across squadrant invocations from
 * different shells. Without this, a captain shell (PATH includes
 * ~/.claude/plugins/cache/* bin dirs) vs a fresh login shell would each
 * rewrite the plist and kickstart -k the daemon, killing in-flight tasks
 * (incident 2026-05-21, observations 8704/8707/8711).
 */
export function sanitizePathForPlist(path: string): string {
  const seen = new Set<string>();
  const stable: string[] = [];
  for (const p of path.split(":")) {
    if (!p) continue;
    if (p.includes("/.claude/plugins/")) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    stable.push(p);
  }
  return stable.join(":");
}

export const AGENT_BINS = ["cmux", "claude", "opencode", "codex", "gemini", "node"];

/**
 * Resolve absolute directories for known agent + tool binaries via `which`, so
 * the launchd daemon's PATH includes them regardless of the install-time shell.
 * Missing binaries are skipped silently.
 */
export function resolveAgentBinDirs(): string[] {
  const dirs: string[] = [];
  for (const bin of AGENT_BINS) {
    try {
      const out = execFileSync("which", [bin], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const resolved = out.trim();
      if (resolved) dirs.push(dirname(resolved));
    } catch {
      // binary not found on this machine — skip
    }
  }
  const seen = new Set<string>();
  return dirs.filter(d => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

/**
 * Compose a stable daemon PATH by prepending resolved agent bin dirs to the
 * sanitized install-shell PATH.  Agent dirs take priority (prepended) and are
 * deduped against the sanitized entries so the output is deterministic.
 */
export function buildDaemonPath(shellPath: string): string {
  const agentDirs = resolveAgentBinDirs();
  const sanitized = sanitizePathForPlist(shellPath);
  if (agentDirs.length === 0) return sanitized;
  const parts = [...agentDirs, ...sanitized.split(":")];
  const seen = new Set<string>();
  return parts.filter(p => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(":");
}

/**
 * Red-team #3 (High): launchd starts the daemon with a minimal PATH that does
 * NOT include where `claude`/`codex`/`opencode` live (nvm/cmux dirs), so every
 * headless `spawn` failed `ENOENT` in the real deployment (shell tests + fake
 * spawn hid it). We bake the installing process's PATH into the plist so the
 * daemon and its spawned crew children resolve the provider binaries.
 */
export function renderPlist(nodeBin: string, daemonEntry: string, pathEnv = ""): string {
  const logPath = join(homedir(), ".config", "squadrant", "squadrantd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(nodeBin)}</string><string>${xmlEscape(daemonEntry)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xmlEscape(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Semantic fingerprint of the <array> block inside the rendered plist. Used by
 * ensureDaemon to distinguish program-argument changes (merit a full restart)
 * from PATH-only changes (write updated plist, don't bounce the daemon).
 */
export function programArgsBlock(nodeBin: string, daemonEntry: string): string {
  return `<array><string>${xmlEscape(nodeBin)}</string><string>${xmlEscape(daemonEntry)}</string></array>`;
}

/**
 * Pure: which kickstart argv to use. `-k` (kill-then-restart) ONLY when the
 * plist changed. A plain `kickstart` starts a down daemon and is a no-op for a
 * healthy one — so a routine CLI call never bounces a running daemon (this was
 * a real bug: ensureDaemon ran on every `squadrant` invocation and `kickstart -k`
 * killed+restarted the daemon each time, orphaning in-flight headless crew).
 */
export function kickstartArgv(target: string, plistChanged: boolean): string[] {
  return plistChanged ? ["kickstart", "-k", target] : ["kickstart", target];
}

// In-process dedup: JS is single-threaded and ensureDaemon is synchronous, so
// true re-entrancy is impossible; this flag prevents sequential re-calls within
// the same process (e.g. index.ts + crew-control.ts) from re-running the
// bootout/bootstrap pair needlessly.
let restartInFlight = false;

/** @internal — reset only in tests; never call from production code */
export function _resetRestartInFlightForTest(): void {
  restartInFlight = false;
}

export function daemonLockPath(): string {
  return join(homedir(), ".config", "squadrant", "daemon.lock");
}

/**
 * Acquire a cross-process filesystem lock at ~/.config/squadrant/daemon.lock.
 * Uses O_EXCL for atomic, race-free creation. Cleans up stale locks (dead PID)
 * before the acquisition loop. Retries with a ~50 ms synchronous sleep up to
 * 20 times (~1 s total) before giving up.
 * Returns true on success, false if another live process holds the lock.
 */
export function tryAcquireDaemonLock(): boolean {
  const lp = daemonLockPath();

  // Stale-lock cleanup: if the owning PID is no longer alive, remove the file
  // so the next O_EXCL attempt succeeds.
  if (existsSync(lp)) {
    try {
      const pid = parseInt(readFileSync(lp, "utf-8").trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        unlinkSync(lp);
      } else {
        try { process.kill(pid, 0); }
        catch { unlinkSync(lp); } // ESRCH → process dead, steal the lock
      }
    } catch { /* read/parse/unlink error — fall through to O_EXCL attempt */ }
  }

  // Atomic acquisition: O_EXCL guarantees only one process creates the file.
  for (let i = 0; i < 20; i++) {
    try {
      const fd = openSync(lp, constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      if (i < 19) {
        // Synchronous sleep: gives the lock-holder time to finish and release.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
  return false; // another live process held the lock for > ~1 s — skip restart
}

/** Release the lock written by tryAcquireDaemonLock. */
export function releaseDaemonLock(): void {
  try { unlinkSync(daemonLockPath()); } catch { /* already cleaned up */ }
}

interface DaemonDrift {
  plistPath: string;
  target: string;
  desired: string;
  current: string | null;
  changed: boolean;
  programChanged: boolean;
  foreignInstall: ForeignInstall | null;
}

/**
 * Read-only: render what the plist SHOULD look like for this environment and
 * diff it against what's on disk. Never writes and never touches launchctl —
 * safe to call from any role purely to detect and report drift. Throws if the
 * compiled daemon entry can't be resolved (see daemonEntryPath).
 */
function computeDaemonDrift(nodeBin: string): DaemonDrift {
  const p = plistPath();
  const entry = daemonEntryPath();
  const desired = renderPlist(nodeBin, entry, buildDaemonPath(process.env.PATH ?? ""));
  const current = existsSync(p) ? readFileSync(p, "utf-8") : null;
  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}/${LABEL}`;

  const changed = current !== desired;
  // Semantic comparison: was the program-arg block itself different (not just
  // PATH)?  Program-arg changes are rare (rebuild/reinstall) and merit a full
  // bootout+reload; PATH varies across terminals so it must NOT trigger a
  // bounce (would orphan in-flight RPCs).
  const programChanged = current !== null && changed
    && !current.includes(programArgsBlock(nodeBin, entry));

  const parsedCurrent = current !== null ? parseProgramArgs(current) : null;
  const foreignInstall = detectForeignInstall(
    parsedCurrent,
    entry,
    parsedCurrent !== null && existsSync(parsedCurrent.daemonEntry),
  );

  return { plistPath: p, target, desired, current, changed, programChanged, foreignInstall };
}

/**
 * The dangerous part: write the plist (if changed), bootout on program-arg
 * drift, bootstrap, and a plain kickstart (never -k, to avoid racing bootout's
 * exit handler — see the comment at the call site). Callers MUST already be
 * authorized to mutate the shared daemon: only ensureDaemon's captain-gated
 * branch and the explicit reregisterDaemon call this.
 */
function applyDaemonDrift(drift: DaemonDrift): void {
  if (drift.changed) {
    mkdirSync(dirname(drift.plistPath), { recursive: true });
    writeFileSync(drift.plistPath, drift.desired);
  }

  if (drift.programChanged) {
    // unload the old instance so bootstrap picks up the new program args
    try { execFileSync("launchctl", ["bootout", drift.target], { stdio: "ignore" }); }
    catch { /* not loaded */ }
  }

  const uid = process.getuid?.() ?? 0;
  try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, drift.plistPath], { stdio: "ignore" }); }
  catch { /* already bootstrapped */ }

  // Plain kickstart (never -k): no-op on a healthy daemon, starts one that
  // was booted-out above or that stopped for other reasons.  -k is avoided
  // because it races with bootout's exit handler and produces exit-113 when
  // the service hasn't finished unloading.
  execFileSync("launchctl", ["kickstart", drift.target], { stdio: "ignore" });
}

/**
 * #636: commands where a human's own act of typing them is itself the
 * authorization to reconcile/start the daemon — distinct from a captain
 * marker, but equally deliberate (never inferred, never incidental):
 *   - `launch`: boots a captain from a bare terminal. It never touches the
 *     daemon socket itself (cmux only), so without this the daemon would
 *     only get registered "one hop later" once the freshly-launched captain
 *     (now SQUADRANT_ROLE=captain-marked) runs its own first command — fine
 *     once a captain exists, but a needless extra step on a fresh install.
 *   - `init`: first-run scaffolding. Doesn't touch the daemon itself either,
 *     but authorizing it means the daemon can be registered as early as the
 *     very first `squadrant` invocation on a new machine.
 * `heal daemon` is deliberately NOT here: it calls reregisterDaemon()
 * directly (see heal.ts), bypassing this gate entirely, so it needs no
 * allowlist entry and works even for an unmarked/pre-upgrade process.
 * Nothing else is on this list on purpose — a crew, a side-session, the
 * dashboard, or cron are incidental, not operator-initiated, and must stay
 * fail-closed even though they too are "a human's system doing something".
 */
export const OPERATOR_INITIATED_COMMANDS = new Set(["launch", "init"]);

/** Pure: was this process's top-level subcommand one of the operator-initiated ones above? */
export function isOperatorInitiatedCommand(topLevelArg: string | undefined): boolean {
  return topLevelArg !== undefined && OPERATOR_INITIATED_COMMANDS.has(topLevelArg);
}

/**
 * Idempotent & cheap. Never throws fatally. Writes/reloads the plist ONLY when
 * its content actually changed, and ONLY when authorized (see below).
 *
 * #636: fail-CLOSED, not fail-open. Absence of authorization must never grant
 * permission to mutate a daemon shared by 26 projects — that was the shape of
 * the original bug (crew-marker absent → act), and it's the same class as
 * #499 (marker-absence treated as a positive signal). So the gate checks
 * POSITIVELY for one of two deliberate signals:
 *   - SQUADRANT_ROLE=captain, set at exactly one place (the captain-launch
 *     choke point in launch-workspace.ts) and nowhere else; or
 *   - opts.operatorInitiated, true only when index.ts resolves the running
 *     subcommand against isOperatorInitiatedCommand (a human explicitly typed
 *     `squadrant launch` or `squadrant init` at a terminal).
 * Any invocation with neither — a claude or codex-shaped crew (codex crews
 * never get SQUADRANT_CREW_TASK_ID either, see crew-control.ts's
 * buildSignalRequest), a side-session, the dashboard, cron, or any other bare
 * CLI subcommand — defaults to "do not touch the daemon", not "go ahead".
 * Drift is still detected and surfaced (stderr note) from every unauthorized
 * call; only the apply step is gated. Real drift stays fixable on purpose via
 * the explicit `squadrant heal daemon` path (reregisterDaemon below), which
 * works regardless of role or authorization.
 *
 * Concurrency guards:
 *   - restartInFlight flag: prevents sequential re-calls within this process
 *     from doing repeat work — including a repeat diagnostic print, since
 *     index.ts's unconditional call and crew-control.ts's on-failure fallback
 *     call can both fire in one process; a second identical stderr note adds
 *     no information, so the flag intentionally covers both the apply path
 *     and the warn-only path, not just the apply path.
 *   - tryAcquireDaemonLock: serialises concurrent SEPARATE squadrant processes
 *     via a filesystem lock so only one runs bootout/bootstrap at a time.
 */
export function ensureDaemon(nodeBin: string = process.execPath, opts: { operatorInitiated?: boolean } = {}): void {
  if (restartInFlight) return;
  restartInFlight = true;

  const authorized = process.env.SQUADRANT_ROLE === "captain" || opts.operatorInitiated === true;

  if (!authorized) {
    // Read-only diagnostic path: never acquires the lock, never writes,
    // never calls launchctl — just tells a human real drift exists.
    try {
      if (computeDaemonDrift(nodeBin).changed) {
        process.stderr.write(
          "[squadrant] note: this machine's registered squadrant daemon config is out " +
          "of date for the version/PATH running right now (common right after an `npm " +
          "update -g squadrant`) — NOT applying it automatically because this command " +
          "isn't the captain and isn't `launch`/`init`. This is usually harmless: the " +
          "next captain command reconciles it on its own. If something looks stale or " +
          "broken right now, run `squadrant heal daemon` to fix it immediately.\n",
        );
      }
    } catch { /* best-effort diagnostic only */ }
    return;
  }

  if (!tryAcquireDaemonLock()) {
    // Another process is handling the restart; it will be done by the time the
    // CLI tries to reach the daemon socket.
    return;
  }

  try {
    const drift = computeDaemonDrift(nodeBin);
    if (drift.foreignInstall) {
      // #670: the plist is owned by a DIFFERENT, still-installed squadrant.
      // Seizing it is exactly what produced the production crash-loop
      // (alternating versions flapping the socket). Leave it untouched and
      // tell a human what to do instead.
      process.stderr.write(printForeignInstallError(drift.foreignInstall));
      return;
    }
    applyDaemonDrift(drift);
  } catch (e) {
    // daemon ensure is best-effort (still don't throw); CLI fails loud on socket miss
    process.stderr.write(`[squadrant] warn: ensureDaemon failed (${e instanceof Error ? e.message : e})\n`);
  } finally {
    releaseDaemonLock();
  }
}

/** Pure: the legible refuse-to-seize error message for a detected foreign install (#670). */
export function printForeignInstallError(foreign: ForeignInstall): string {
  return (
    "[squadrant] refusing to restart the daemon: the registered launchd config belongs to a " +
    "DIFFERENT squadrant install than this one.\n" +
    `  registered install: ${foreign.registeredEntry}\n` +
    `  this install:        ${foreign.thisEntry}\n` +
    "  Two squadrant installs on this machine will keep fighting over the daemon (#670). " +
    "Uninstall the one you don't use, then run `squadrant heal daemon` to reconcile.\n"
  );
}

/**
 * Explicit operator path for #636: `squadrant heal daemon` calls this
 * directly, regardless of role, to intentionally reconcile the plist against
 * the current environment (PATH drift, entry-path drift) and apply it. This
 * is the opt-in the issue asks for — a deliberate human action, never an
 * implicit side effect of an arbitrary CLI invocation.
 */
export function reregisterDaemon(nodeBin: string = process.execPath): void {
  if (!tryAcquireDaemonLock()) return;
  try {
    applyDaemonDrift(computeDaemonDrift(nodeBin));
  } finally {
    releaseDaemonLock();
  }
}
