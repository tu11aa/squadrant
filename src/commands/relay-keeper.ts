// src/commands/relay-keeper.ts
//
// #224: cmux-tree-resident auto-heal for the notify-relay. Runs as a one-shot
// CLI tick inside a shell supervisor loop (buildRelayKeeperCommand). Polls the
// daemon's relay-health verdict via the 'health' socket verb and, when the relay
// is gone + captain is present, re-spawns the relay tab via the runtime driver's
// spawnInjector — which WORKS in production because the keeper is a cmux-tree
// descendant, unlike the launchd daemon's healer.
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { RuntimeRegistry, createCmuxDriver } from "../runtimes/index.js";
import type { RuntimeDriver, WorkspaceRef } from "../runtimes/types.js";
import { sendRequest } from "../control/protocol.js";
import { buildRelaySupervisorCommand, NOTIFY_RELAY_TAB_TITLE } from "../control/relay-supervisor.js";
import type { ComponentHealth } from "../control/liveness.js";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");

// ── Pure decision logic (unit-testable) ─────────────────────────────────

export type KeeperAction = { action: "skip"; reason: string } | { action: "respawn" };

/**
 * Pure. Given the daemon's health data for one project, decide whether the
 * keeper should respawn the relay tab. Never throws.
 *
 *   - relay alive/stale → skip (healthy or within heartbeat budget)
 *   - relay gone + captain alive → respawn
 *   - relay gone + captain absent → skip (nothing to inject into)
 *   - no relay health data → skip (daemon unreachable / no project)
 */
export function decideKeeperAction(
  health: ComponentHealth[],
  project: string,
): KeeperAction {
  const relay = health.find((c) => c.kind === "relay" && c.project === project);
  if (!relay) return { action: "skip", reason: "no relay health data" };

  if (relay.state === "alive" || relay.state === "stale" || relay.state === "unknown") {
    return { action: "skip", reason: `relay is ${relay.state}` };
  }

  // relay is "gone" or "unknown" — only respawn if the captain is present.
  const captain = health.find((c) => c.kind === "captain" && c.project === project);
  if (captain?.state !== "alive") {
    return { action: "skip", reason: `captain not alive (${captain?.state ?? "n/a"})` };
  }

  return { action: "respawn" };
}

// ── One tick ────────────────────────────────────────────────────────────

/**
 * One keeper tick: query the daemon's relay-health, decide if a respawn is
 * needed, and if so dedup + spawnInjector the relay tab. Never throws — all
 * I/O is caught and logged so a transient daemon/cmux blip never crashes the
 * keeper process (and the shell loop re-polls ~15s later).
 *
 * @param fetchHealth  Injectable health source (defaults to real daemon socket).
 *                     Tests supply a fake to avoid mocking sendRequest at the
 *                     module level.
 */
export async function runRelayKeeperTick(
  project: string,
  runtime: RuntimeDriver,
  captainName: string,
  log: (m: string) => void = () => {},
  fetchHealth?: (project: string) => Promise<ComponentHealth[]>,
): Promise<void> {
  const getHealth = fetchHealth ?? (async (p: string) => {
    const res = await sendRequest(SOCK, { kind: "health", project: p });
    return Array.isArray(res) ? (res as ComponentHealth[]) : [];
  });
  let health: ComponentHealth[];
  try {
    health = await getHealth(project);
    if (!Array.isArray(health)) {
      log("relay-keeper: health response not an array");
      return;
    }
  } catch (e) {
    log(`relay-keeper: daemon unreachable (${(e as Error).message})`);
    return;
  }

  const verdict = decideKeeperAction(health, project);
  if (verdict.action === "skip") return;

  // Respawn: resolve captain workspace, dedup existing relay tab, inject.
  let ws: WorkspaceRef | null;
  try {
    ws = await runtime.status(captainName);
  } catch {
    log("relay-keeper: captain workspace lookup failed");
    return;
  }
  if (!ws) {
    log("relay-keeper: captain workspace not found");
    return;
  }

  // Dedup: close any pre-existing relay tab before respawning fresh.
  try {
    const surfaces = await runtime.listSurfaces(ws.id);
    for (const s of surfaces) {
      if (s.title === NOTIFY_RELAY_TAB_TITLE) {
        try { await runtime.closePane(s); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }

  try {
    await runtime.spawnInjector({
      captainWorkspace: ws,
      command: buildRelaySupervisorCommand(project),
      title: NOTIFY_RELAY_TAB_TITLE,
      placement: "background",
    });
    log(`relay-keeper: re-spawned notify-relay tab for '${project}'`);
  } catch (e) {
    log(`relay-keeper: spawnInjector failed — ${(e as Error).message}`);
  }
}

// ── CLI command ─────────────────────────────────────────────────────────

export const relayKeeperCommand = new Command("relay-keeper")
  .description(
    "One-shot relay-health poll + auto-heal. Runs as a cmux-resident loop " +
    "(wrapped in buildRelayKeeperCommand) to re-spawn the notify-relay tab " +
    "when the daemon reports it gone.",
  )
  .argument("<project>", "Project whose relay to watch")
  .action(async (project: string) => {
    const config = loadConfig();
    const projCfg = config.projects[project];
    if (!projCfg) {
      console.error(chalk.red(`relay-keeper: unknown project '${project}'`));
      process.exit(1);
    }
    const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
    const runtime = registry.forProject(project, config);
    const log = (m: string) => process.stdout.write(`[relay-keeper ${project}] ${m}\n`);
    await runRelayKeeperTick(project, runtime, projCfg.captainName, log);
  });
