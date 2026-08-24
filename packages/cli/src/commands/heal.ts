// src/commands/heal.ts
//
// squadrant heal <component> — targeted, idempotent, machine-readable remediation
// surface for the detect → notify → remediate loop (#234).
//
// Subcommands:
//   heal status   — dry-run: print unhealthy components + the exact heal command
//   heal daemon   — restart squadrantd via the existing launchd kickstart path
//   heal captain  — #699 escape hatch: re-adopt a RUNNING captain whose cmux
//                   argv was truncated (see store-fingerprint.ts's argv fallback
//                   for the primary, automatic fix — this is the manual hand-hold
//                   for when that self-heal hasn't run yet, e.g. before an
//                   upgrade lands on a still-running daemon).
//
// DEFERRED: heal crew <id> — re-attach a stuck crew task (overlaps #100, more
// complex; explicitly out of MVP scope).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import type { RuntimeLivenessRecord, LivenessEntry } from "@squadrant/shared";
import { queryHealth, SOCK } from "./health-view.js";
import { healCmdFor } from "@squadrant/core";
import type { ComponentHealth, HealthState } from "@squadrant/core";
import { reregisterDaemon, isDaemonSocketLive, defaultIsPidAlive, LivenessRegistry, LABEL } from "@squadrant/core";
import { readCmuxLiveness } from "@squadrant/workspaces";

// ── pure helpers (fully unit-testable, no I/O) ────────────────────────────────

// Re-exported so existing consumers (tests + external code) that import from
// this module continue to work without changes.
export { healCmdFor };

export interface HealComponent {
  kind: ComponentHealth["kind"];
  project: string;
  ref: string;
  state: HealthState;
  detail?: string;
  healCmd: string | null;
}

export interface HealStatusResult {
  healthy: boolean;
  daemonUnreachable?: boolean;
  components: HealComponent[];
}

/**
 * Pure. Assemble the HealStatusResult from a raw liveness snapshot.
 * null input = daemon unreachable.
 */
export function buildHealStatus(components: ComponentHealth[] | null): HealStatusResult {
  if (components === null) {
    return { healthy: false, daemonUnreachable: true, components: [] };
  }
  const out: HealComponent[] = components.map((c) => ({
    kind: c.kind,
    project: c.project,
    ref: c.ref,
    state: c.state,
    detail: c.detail,
    healCmd: healCmdFor(c),
  }));
  const healthy = out.every((c) => {
    if (c.kind === "delivery") {
      return c.state === "alive" || c.state === "stopped" || c.state === "unknown";
    }
    return c.healCmd === null;
  });
  return { healthy, components: out };
}

// ── injectable runners (used by Commander actions + tests) ────────────────────

export interface HealStatusOpts {
  project: string | undefined;
  json: boolean;
  queryHealth: typeof queryHealth;
  /** Ground-truth liveness probe (#671) — defaults to a real socket connect(). */
  isDaemonAlive?: () => Promise<boolean>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Returns exit code: 0=all healthy, 1=error/daemon-unreachable, 2=unhealthy
 *
 * #671: an empty component list is only "healthy" when the daemon actually
 * answered it — buildHealStatus([]) is vacuously true (empty.every() ===
 * true), which is correct for a freshly-started daemon with no registered
 * projects but was mistaken for "the daemon is up" during the #670 incident
 * even with zero squadrantd processes running. isDaemonAlive is a direct
 * ground-truth probe (socket connect()) checked BEFORE trusting any
 * component data, so a dead daemon is never reported healthy no matter what
 * queryHealth happens to return.
 */
export async function runHealStatus(opts: HealStatusOpts): Promise<number> {
  const { project, json, stdout, stderr } = opts;
  const isDaemonAlive = opts.isDaemonAlive ?? (() => isDaemonSocketLive(SOCK));

  if (!(await isDaemonAlive())) {
    if (json) {
      stdout.write(JSON.stringify({ healthy: false, daemonUnreachable: true, components: [] }) + "\n");
    } else {
      stderr.write("daemon unreachable — start the daemon first (squadrant heal daemon)\n");
    }
    return 1;
  }

  let rows: ComponentHealth[] | null;
  try {
    rows = await opts.queryHealth(project);
  } catch (e) {
    stderr.write(`heal status: ${(e as Error).message}\n`);
    return 1;
  }

  const result = buildHealStatus(rows);

  if (result.daemonUnreachable) {
    if (json) {
      stdout.write(JSON.stringify({ healthy: false, daemonUnreachable: true, components: [] }) + "\n");
    } else {
      stderr.write("daemon unreachable — start the daemon first (squadrant heal daemon)\n");
    }
    return 1;
  }

  if (json) {
    stdout.write(JSON.stringify(result) + "\n");
    return result.healthy ? 0 : 2;
  }

  if (result.healthy) {
    stdout.write(chalk.green("✔ all components healthy\n"));
    return 0;
  }

  stdout.write(chalk.bold("Unhealthy components:\n\n"));
  for (const c of result.components) {
    const isUnhealthy = c.kind === "delivery"
      ? (c.state !== "alive" && c.state !== "stopped" && c.state !== "unknown")
      : c.healCmd !== null;
    if (isUnhealthy) {
      const glyph = c.state === "stale" ? chalk.yellow("•") : chalk.red("✘");
      const stateColor = c.state === "stale" ? chalk.yellow : chalk.red;
      stdout.write(`  ${glyph} ${c.kind.padEnd(8)} ${c.ref.padEnd(16)} ${stateColor(c.state.padEnd(8))} ${c.project}\n`);
      if (c.detail) {
        stdout.write(`      detail: ${c.detail}\n`);
      }
      if (c.healCmd) {
        stdout.write(`      heal: ${chalk.cyan(c.healCmd)}\n`);
      }
    }
  }
  return 2;
}

export interface HealDaemonOpts {
  ensureDaemon: () => void;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Returns exit code: 0=success, 1=error */
export async function runHealDaemon(opts: HealDaemonOpts): Promise<number> {
  const { stdout, stderr } = opts;
  stdout.write("restarting squadrantd via launchd kickstart...\n");
  try {
    opts.ensureDaemon();
    stdout.write(chalk.green("✔ daemon kickstart complete\n"));
    return 0;
  } catch (e) {
    stderr.write(`heal daemon failed: ${(e as Error).message}\n`);
    return 1;
  }
}

export interface ResolvedCaptain {
  project: string;
  pid: number;
  sessionId: string;
}

/**
 * Pure. Pick the live captain for one project from a runtime liveness snapshot
 * — same "prefer a confirmed-alive pid" rule `runLivenessTick` uses. Returns
 * null when no candidate has a confirmed-alive pid: a hibernated (pid:null)
 * or dead captain is not something `heal captain` re-adopts — it never
 * invents an entry for a pid that isn't actually running (#699).
 */
export function resolveLiveCaptain(
  records: RuntimeLivenessRecord[],
  project: string,
  isPidAlive: (pid: number) => boolean,
): ResolvedCaptain | null {
  const winner = records.find(
    (r) => r.role === "captain" && r.project === project && r.pid != null && isPidAlive(r.pid),
  );
  if (!winner || winner.pid == null) return null;
  return { project, pid: winner.pid, sessionId: winner.sessionId };
}

export interface HealCaptainDeps {
  /** Ground-truth captain records from the cmux store (+ OS argv fallback). */
  liveness: () => Promise<RuntimeLivenessRecord[]>;
  isPidAlive: (pid: number) => boolean;
  now: () => number;
  /** Current registry entry for a project, if any — used to skip a no-op heal. */
  getEntry: (project: string) => LivenessEntry | undefined;
  /** Write the corrected entry into the on-disk LivenessRegistry. */
  applyEntry: (entry: LivenessEntry) => void;
  /** Reload the daemon so it re-reads liveness.json (write-then-kickstart -k). */
  kickstartDaemon: () => void;
  /**
   * Fresh, on-disk read of a project's registry entry, taken AFTER a
   * kickstart. The still-dying old daemon persists its own in-memory map
   * every tick and can clobber our write in the window before `kickstart -k`'s
   * kill actually lands — this must re-read from disk, not return whatever
   * `getEntry`'s backing instance already has in memory (that would just
   * echo our own write back and never catch the clobber).
   */
  reloadEntry: (project: string) => LivenessEntry | undefined;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface HealTarget {
  project: string;
  resolved: ResolvedCaptain;
}

/** Pure: does an on-disk entry reflect the resolved live captain? */
function entryMatchesResolved(entry: LivenessEntry | undefined, resolved: ResolvedCaptain): boolean {
  return entry?.role === "captain" && entry.pid === resolved.pid && entry.sessionId === resolved.sessionId &&
    entry.lastState === "start" && entry.pidAlive === true;
}

/** Write + kickstart one batch, then verify each target actually landed on disk. */
function applyAndVerify(targets: HealTarget[], deps: HealCaptainDeps): Set<string> {
  const now = deps.now();
  for (const { project, resolved } of targets) {
    deps.applyEntry({
      project, role: "captain", pid: resolved.pid, sessionId: resolved.sessionId,
      startedAt: now, lastState: "start", lastSeenAt: now, pidAlive: true, source: "runtime",
    });
  }
  deps.kickstartDaemon();
  const landed = new Set<string>();
  for (const { project, resolved } of targets) {
    if (entryMatchesResolved(deps.reloadEntry(project), resolved)) landed.add(project);
  }
  return landed;
}

/**
 * Returns exit code: 0=success (including "nothing needed healing"), 1=error
 * or a heal that still didn't land after the retry.
 *
 * Idempotent: a project whose registry entry already matches the resolved
 * live captain is left untouched — no write, no kickstart. Projects that
 * needed correcting are written and verified after a single shared kickstart;
 * the still-dying old daemon can clobber that write in the race window before
 * its kill lands (#699 review), so a mismatch after kickstart gets exactly
 * one retry (re-write + re-kickstart) before being reported as a real failure
 * — never claimed as healed when it didn't actually land.
 */
export async function runHealCaptain(projects: string[], deps: HealCaptainDeps): Promise<number> {
  const { stdout, stderr } = deps;
  let records: RuntimeLivenessRecord[];
  try {
    records = await deps.liveness();
  } catch (e) {
    stderr.write(`heal captain: could not read cmux liveness store: ${(e as Error).message}\n`);
    return 1;
  }

  const targets: HealTarget[] = [];
  for (const project of projects) {
    const resolved = resolveLiveCaptain(records, project, deps.isPidAlive);
    if (!resolved) {
      stdout.write(`  ${chalk.yellow("–")} ${project}: no live captain found — nothing to heal\n`);
      continue;
    }
    if (entryMatchesResolved(deps.getEntry(project), resolved)) {
      stdout.write(`  ${chalk.green("✔")} ${project}: already healthy (pid=${resolved.pid})\n`);
      continue;
    }
    targets.push({ project, resolved });
  }

  if (targets.length === 0) return 0;

  let landed: Set<string>;
  try {
    landed = applyAndVerify(targets, deps);
  } catch (e) {
    stderr.write(`heal captain: registry updated but daemon kickstart failed: ${(e as Error).message}\n`);
    return 1;
  }

  let stillMissing = targets.filter((t) => !landed.has(t.project));
  if (stillMissing.length > 0) {
    try {
      const retryLanded = applyAndVerify(stillMissing, deps);
      stillMissing = stillMissing.filter((t) => !retryLanded.has(t.project));
    } catch (e) {
      stderr.write(`heal captain: retry write/kickstart failed: ${(e as Error).message}\n`);
      return 1;
    }
  }

  const stillMissingSet = new Set(stillMissing.map((t) => t.project));
  for (const { project, resolved } of targets) {
    if (stillMissingSet.has(project)) {
      stderr.write(
        `  ${chalk.red("✘")} ${project}: heal did not survive the daemon restart after one retry — ` +
        `pid=${resolved.pid} sessionId=${resolved.sessionId} may be racing the daemon's own periodic persist\n`,
      );
    } else {
      stdout.write(`  ${chalk.green("✔")} ${project}: re-adopted captain pid=${resolved.pid} sessionId=${resolved.sessionId}\n`);
    }
  }

  if (stillMissingSet.size > 0) return 1;
  stdout.write(chalk.green(`✔ healed ${targets.length} captain(s); daemon kickstarted\n`));
  return 0;
}

/** Real kickstart: write-then-`-k`, never `bootout` (loses the ~2s KeepAlive respawn race — #699). */
function kickstartDaemonForHealCaptain(): void {
  const uid = process.getuid?.() ?? 0;
  execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
}

// ── Commander command tree ────────────────────────────────────────────────────

export const healCommand = new Command("heal")
  .description("Targeted, idempotent remediation for squadrant components (daemon, health)")
  .addHelpText("after", "\nDeferred: 'squadrant heal crew <id>' (re-attach) — see issue #100.")
  .addCommand(
    new Command("status")
      .description("Dry-run: print unhealthy components and the exact heal command for each")
      .option("-p, --project <project>", "scope to one project")
      .option("--json", "output machine-readable JSON (exit 0=healthy, 1=error, 2=unhealthy)")
      .action(async (opts: { project?: string; json?: boolean }) => {
        const code = await runHealStatus({
          project: opts.project,
          json: opts.json ?? false,
          queryHealth,
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command("daemon")
      .description("Explicitly reconcile + restart squadrantd (#636 operator opt-in — reads current PATH/entry drift and applies it, regardless of role)")
      .action(async () => {
        const code = await runHealDaemon({
          ensureDaemon: () => reregisterDaemon(),
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command("captain")
      .description(
        "#699 escape hatch: re-adopt a RUNNING captain the daemon can't classify (truncated cmux argv) " +
        "without relaunching it — resolves the live captain from the cmux store + process table, corrects " +
        "the liveness registry, then reloads the daemon.",
      )
      .argument("[project]", "Project name to heal captain liveness for")
      .option("--all", "heal captain liveness for every project")
      .action(async (project: string | undefined, opts: { all?: boolean }) => {
        if (!opts.all && !project) {
          process.stderr.write("heal captain: specify a project name, or pass --all\n");
          process.exit(1);
        }
        const config = loadConfig();
        const projects = opts.all ? Object.keys(config.projects) : [project as string];
        const stateRoot = join(homedir(), ".config", "squadrant", "state");
        const registry = new LivenessRegistry({ path: join(stateRoot, "liveness.json") });
        registry.load();
        const code = await runHealCaptain(projects, {
          liveness: readCmuxLiveness,
          isPidAlive: defaultIsPidAlive,
          now: () => Date.now(),
          getEntry: (p) => registry.get(p),
          applyEntry: (e) => registry.apply(e),
          kickstartDaemon: kickstartDaemonForHealCaptain,
          // Fresh disk read (not the in-memory instance's stale view) — this
          // is what actually detects the running daemon's own persist
          // clobbering our write in the race window before kickstart's kill
          // lands (#699 review).
          reloadEntry: (p) => { registry.load(); return registry.get(p); },
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  );
