// src/commands/dispatch.ts
//
// Cross-project reach, tracked tier: dispatch a task to ANY registered
// project. Creates a tracked task, notifies the target captain, and reports
// back to the origin on settle. Reuses the existing dispatch machinery in
// @squadrant/core (group-dispatch.ts) — same-group dispatch additionally
// gets auto-accept-by-default and boot-if-down; cross-group respects
// acceptDelegations and does not auto-boot a down captain.
//
// `squadrant group dispatch` is a deprecated alias for this command (group.ts).

import { Command } from "commander";
import { execFile } from "node:child_process";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { dispatchToSibling, resolveCurrentProject, GROUP_DISPATCH_WARMUP_TIMEOUT_MS } from "@squadrant/core";
import type { Provider, Mode, TaskRecord } from "@squadrant/shared";

export interface DispatchCliOpts {
  provider?: Provider;
  mode?: Mode;
  warmupTimeout?: number;
}

export async function runDispatch(toProject: string, task: string, opts: DispatchCliOpts): Promise<TaskRecord> {
  const fromProject = resolveCurrentProject(loadConfig());
  if (!fromProject) {
    throw new Error("Could not determine current project from cwd. Run from inside a registered project directory.");
  }

  return dispatchToSibling({
    fromProject,
    toProject,
    task,
    provider: opts.provider,
    mode: opts.mode,
    warmupTimeoutMs: opts.warmupTimeout,
    bootCaptain: (project) => bootCaptain(project, opts.warmupTimeout ?? GROUP_DISPATCH_WARMUP_TIMEOUT_MS),
  });
}

// #999: a first boot creates a cmux workspace and stays alive delivering the
// startup prompt, which routinely outlasts the old 15s cap — so launch gets the
// warmup budget, and its real failure (exit code + stderr) is reported instead
// of a blanket "is squadrant installed?" that only ENOENT actually means.
function bootCaptain(project: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("squadrant", ["launch", project], { encoding: "utf-8", timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT") {
        return reject(new Error(`failed to launch captain for '${project}' — is squadrant installed?`));
      }
      if (e.killed) {
        return reject(new Error(`'squadrant launch ${project}' did not finish within ${timeoutMs / 1000}s`));
      }
      const detail = String(stderr ?? "").trim();
      reject(new Error(`'squadrant launch ${project}' failed (exit ${e.code ?? "?"})${detail ? `: ${detail}` : ""}`));
    });
  });
}

export async function dispatchAction(toProject: string, task: string, opts: DispatchCliOpts): Promise<void> {
  try {
    const result = await runDispatch(toProject, task, opts);
    console.log(chalk.green(`✔ Dispatched to '${toProject}' (task ${result.id.slice(0, 8)})`));
    console.log(chalk.dim(`  originProject: ${result.originProject ?? "none"}`));
    console.log(chalk.dim("  You will be notified when the task settles (done/blocked/failed)."));
  } catch (e) {
    console.error(chalk.red(`✘ ${(e as Error).message}`));
    process.exit(1);
  }
}

export const dispatchCommand = new Command("dispatch")
  .description("Dispatch a task to any registered project (tracked, reports back on settle)")
  .argument("<project>", "Target project name")
  .argument("<task>", "Task description to dispatch")
  .option("--provider <p>", "claude|opencode|codex", "claude")
  .option("--mode <m>", "headless|interactive", "headless")
  .option("--warmup-timeout <s>", "seconds to wait for target captain to boot (same-group only; default: 120)", (v) => parseInt(v, 10) * 1000)
  .action(dispatchAction);
