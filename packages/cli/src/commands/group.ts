// src/commands/group.ts
//
// #246: cross-project intra-group delegation. `cockpit group dispatch`
// sends a task to a sibling project in the same group. The target's captain
// is woken via the existing mailbox/relay path. A dispatches-and-yields;
// the origin captain is auto-woken when the task settles (report-back).

import { Command } from "commander";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig, resolveHome, type CockpitConfig } from "@cockpit/shared";
import { sendRequest } from "@cockpit/core";
import type { TaskRecord, Provider, Mode } from "@cockpit/shared";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");
// #288: 30s was too short — cold captain boot + relay supervisor startup takes
// 45-90s. 120s gives the full chain (Claude init + checklist + relay register)
// comfortable headroom while still failing fast on a genuinely broken launch.
const WARMUP_TIMEOUT_MS = 120_000;
const WARMUP_POLL_MS = 1_000;

/** Resolve the current project name by matching cwd against config paths. */
export function resolveCurrentProject(config: CockpitConfig): string | null {
  const cwd = process.cwd();
  for (const [name, proj] of Object.entries(config.projects)) {
    const resolvedPath = resolveHome(proj.path);
    if (cwd.startsWith(resolvedPath)) return name;
  }
  return null;
}

/** Check via the daemon health endpoint whether a project's captain is up. */
async function isCaptainAlive(project: string): Promise<boolean> {
  try {
    const health = (await sendRequest(SOCK, { kind: "health", project }, 5000)) as Array<{
      kind: string; project: string; state: string;
    }>;
    const captain = health?.find((h) => h.kind === "captain" && h.project === project);
    return captain != null && captain.state !== "gone" && captain.state !== "unknown";
  } catch {
    return false;
  }
}

/** Poll the daemon health endpoint until the target project's relay is up,
 *  or the hard timeout expires. Returns true if warmup succeeded. */
export async function waitForWarmup(
  project: string,
  timeoutMs = WARMUP_TIMEOUT_MS,
  pollMs = WARMUP_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCaptainAlive(project)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export interface GroupDispatchOpts {
  fromProject: string;
  toProject: string;
  task: string;
  provider?: Provider;
  mode?: Mode;
  warmupTimeoutMs?: number;
  warmupPollMs?: number;
}

/** Pure-ish dispatch function (extracted for testability). */
export async function runGroupDispatch(opts: GroupDispatchOpts): Promise<TaskRecord> {
  const config = loadConfig();
  const fromCfg = config.projects[opts.fromProject];
  const toCfg = config.projects[opts.toProject];

  if (!toCfg) {
    throw new Error(`target project '${opts.toProject}' not found in config`);
  }

  // #246: same-group gate — hard boundary
  if (!fromCfg.group || !toCfg.group || fromCfg.group !== toCfg.group) {
    throw new Error(
      `cannot dispatch: '${opts.toProject}' (group: ${toCfg.group ?? "none"}) ` +
      `is not in the same group as '${opts.fromProject}' (group: ${fromCfg.group ?? "none"})`,
    );
  }

  // #246: acceptDelegations check
  if (toCfg.acceptDelegations === false) {
    throw new Error(
      `cannot dispatch to '${opts.toProject}': project has acceptDelegations set to false`,
    );
  }

  // Ensure B's captain/relay is up
  const alive = await isCaptainAlive(opts.toProject);
  if (!alive) {
    try {
      execSync(`cockpit launch ${opts.toProject}`, { stdio: "ignore", timeout: 15_000 });
    } catch {
      throw new Error(`failed to launch captain for '${opts.toProject}' — is cockpit installed?`);
    }

    const warmed = await waitForWarmup(opts.toProject, opts.warmupTimeoutMs, opts.warmupPollMs);
    if (!warmed) {
      throw new Error(
        `dispatch to '${opts.toProject}' timed out waiting for captain warmup ` +
        `(>${(opts.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS) / 1000}s)`,
      );
    }
  }

  // Record the task via the daemon
  const now = Date.now();
  const attemptId = randomUUID();
  const record: TaskRecord = {
    id: randomUUID(),
    project: opts.toProject,
    originProject: opts.fromProject,
    provider: opts.provider ?? "claude",
    mode: opts.mode ?? "headless",
    state: "submitted",
    task: opts.task,
    createdAt: now,
    lastHeartbeat: now,
    lastEvent: "dispatch",
    heartbeatBudgetMs: 300000,
    attempts: [{ attemptId, startedAt: now, lastHeartbeatAt: now }],
  };

  const result = await sendRequest(SOCK, { kind: "dispatch", record }) as TaskRecord;
  return result;
}

// ── CLI command ──────────────────────────────────────────────────────────────

export const groupCommand = new Command("group")
  .description("Cross-project intra-group operations (Phase 1: dispatch)")
  .addCommand(
    new Command("dispatch")
      .description("Dispatch a task to a sibling project in the same group")
      .argument("<to-project>", "Target project name (must be in the same group)")
      .argument("<task>", "Task description to dispatch")
      .option("--provider <p>", "claude|opencode|codex", "claude")
      .option("--mode <m>", "headless|interactive", "headless")
      .option("--warmup-timeout <s>", "seconds to wait for target captain relay to boot (default: 120)", (v) => parseInt(v, 10) * 1000)
      .action(async (toProject: string, task: string, opts: { provider?: Provider; mode?: Mode; warmupTimeout?: number }) => {
        const fromProject = resolveCurrentProject(loadConfig());
        if (!fromProject) {
          console.error(chalk.red("Could not determine current project from cwd. Run from inside a registered project directory."));
          process.exit(1);
        }

        try {
          const result = await runGroupDispatch({
            fromProject,
            toProject,
            task,
            provider: opts.provider,
            mode: opts.mode,
            warmupTimeoutMs: opts.warmupTimeout,
          });
          console.log(chalk.green(`✔ Dispatched to '${toProject}' (task ${result.id.slice(0, 8)})`));
          console.log(chalk.dim(`  originProject: ${result.originProject ?? "none"}`));
          console.log(chalk.dim("  You will be notified when the task settles (done/blocked/failed)."));
        } catch (e) {
          console.error(chalk.red(`✘ ${(e as Error).message}`));
          process.exit(1);
        }
      }),
  );
