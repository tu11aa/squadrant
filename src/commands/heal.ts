// src/commands/heal.ts
//
// cockpit heal <component> — targeted, idempotent, machine-readable remediation
// surface for the detect → notify → remediate loop (#234).
//
// Subcommands:
//   heal status  — dry-run: print unhealthy components + the exact heal command
//   heal relay   — re-establish the notify-relay (lineage-safe, idempotent)
//   heal daemon  — restart cockpitd via the existing launchd kickstart path
//
// DEFERRED: heal crew <id> — re-attach a stuck crew task (overlaps #100, more
// complex; explicitly out of MVP scope).
import { Command } from "commander";
import chalk from "chalk";
import { queryHealth } from "./health-view.js";
import { createRelayHealer, healCmdFor } from "@cockpit/core";
import type { RelayHealOutcome } from "@cockpit/core";
import { ensureDaemon as _ensureDaemon } from "@cockpit/core";
import type { ComponentHealth, HealthState } from "@cockpit/core";

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
      stderr.write("daemon unreachable — start the daemon first (cockpit heal daemon)\n");
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

export interface HealRelayOpts {
  project: string;
  queryHealth: typeof queryHealth;
  relayHealer: (project: string) => Promise<RelayHealOutcome | void>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Returns exit code: 0=success/already-healthy, 1=error */
export async function runHealRelay(opts: HealRelayOpts): Promise<number> {
  const { project, stdout, stderr } = opts;
  let rows: ComponentHealth[] | null;
  try {
    rows = await opts.queryHealth(project);
  } catch (e) {
    stderr.write(`heal relay: ${(e as Error).message}\n`);
    return 1;
  }

  if (rows === null) {
    stderr.write("daemon unreachable — start the daemon first (cockpit heal daemon)\n");
    return 1;
  }

  const relay = rows.find((c) => c.kind === "relay" && c.project === project);
  const state = relay?.state ?? "unknown";

  // Strict idempotency: 'alive' or 'stale' means a heartbeat was recently
  // received, so the #240-supervised relay is functioning or recovering.
  // Do not compete with the captain's supervisor in that window.
  if (state === "alive" || state === "stale") {
    stdout.write(chalk.green(`✔ relay for '${project}' already healthy (${state}) — no action taken\n`));
    return 0;
  }

  // 'gone' or 'unknown': no supervised relay is running; spawn manually.
  stdout.write(`relay for '${project}' is ${state} — re-establishing...\n`);
  try {
    await opts.relayHealer(project);
    stdout.write(chalk.green(`✔ relay re-establish attempted for '${project}'\n`));
    // TODO(#240): if the captain's harness-wake fires in this same window, a
    // second relay could briefly start (two relays draining the mailbox →
    // duplicate deliveries). Acceptable in MVP; revisit when #240 adds a relay
    // presence check before waking.
    return 0;
  } catch (e) {
    stderr.write(`heal relay failed: ${(e as Error).message}\n`);
    return 1;
  }
}

export interface HealDaemonOpts {
  ensureDaemon: () => void;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Returns exit code: 0=success, 1=error */
export async function runHealDaemon(opts: HealDaemonOpts): Promise<number> {
  const { stdout, stderr } = opts;
  stdout.write("restarting cockpitd via launchd kickstart...\n");
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
  .description("Targeted, idempotent remediation for cockpit components (relay, daemon)")
  .addHelpText("after", "\nDeferred: 'cockpit heal crew <id>' (re-attach) — see issue #100.")
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
    new Command("relay")
      .description(
        "Re-establish the notify-relay for a project (lineage-safe, idempotent).\n" +
        "No-op when relay is alive or stale — the #240 captain-owned supervisor is the primary path;\n" +
        "this is the manual fallback for when no supervised relay is running.",
      )
      .argument("<project>", "project to re-establish the relay for")
      .option("-p, --project <project>", "alias for the positional project argument")
      .action(async (positional: string, opts: { project?: string }) => {
        const project = opts.project ?? positional;
        const healer = createRelayHealer((m) => process.stdout.write(m + "\n"));
        const code = await runHealRelay({
          project,
          queryHealth,
          relayHealer: healer,
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command("daemon")
      .description("Restart cockpitd via the idempotent launchd kickstart path")
      .action(async () => {
        const code = await runHealDaemon({
          ensureDaemon: _ensureDaemon,
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  );
