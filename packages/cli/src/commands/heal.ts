// src/commands/heal.ts
//
// squadrant heal <component> — targeted, idempotent, machine-readable remediation
// surface for the detect → notify → remediate loop (#234).
//
// Subcommands:
//   heal status  — dry-run: print unhealthy components + the exact heal command
//   heal daemon  — restart squadrantd via the existing launchd kickstart path
//
// DEFERRED: heal crew <id> — re-attach a stuck crew task (overlaps #100, more
// complex; explicitly out of MVP scope).
import { Command } from "commander";
import chalk from "chalk";
import { queryHealth } from "./health-view.js";
import { healCmdFor } from "@squadrant/core";
import type { ComponentHealth, HealthState } from "@squadrant/core";
import { restartDaemonIfRunning } from "@squadrant/core";

// ── pure helpers (fully unit-testable, no I/O) ────────────────────────────────

// Re-exported so existing consumers (tests + external code) that import from
// this module continue to work without changes.
export { healCmdFor };

export interface HealComponent {
  kind: ComponentHealth["kind"];
  project: string;
  ref: string;
  state: HealthState;
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
    healCmd: healCmdFor(c),
  }));
  const healthy = out.every((c) => c.healCmd === null);
  return { healthy, components: out };
}

// ── injectable runners (used by Commander actions + tests) ────────────────────

export interface HealStatusOpts {
  project: string | undefined;
  json: boolean;
  queryHealth: typeof queryHealth;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Returns exit code: 0=all healthy, 1=error/daemon-unreachable, 2=unhealthy */
export async function runHealStatus(opts: HealStatusOpts): Promise<number> {
  const { project, json, stdout, stderr } = opts;
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
    if (c.healCmd) {
      stdout.write(`  ${chalk.red("✘")} ${c.kind.padEnd(8)} ${c.ref.padEnd(16)} ${chalk.red(c.state.padEnd(8))} ${c.project}\n`);
      stdout.write(`      heal: ${chalk.cyan(c.healCmd)}\n`);
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
      .description("Restart squadrantd via the idempotent launchd kickstart path")
      .action(async () => {
        const code = await runHealDaemon({
          ensureDaemon: () => restartDaemonIfRunning({ reason: "heal", isRunning: () => true }),
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  );
