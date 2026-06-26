// src/commands/group.ts
//
// #246: cross-project intra-group delegation. `squadrant group dispatch`
// sends a task to a sibling project in the same group. Thin wrapper:
// parse args → construct CLI-edge bootCaptain → call dispatchToSibling → format.

import { Command } from "commander";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { dispatchToSibling, resolveCurrentProject } from "@squadrant/core";
import type { Provider, Mode } from "@squadrant/shared";

export { resolveCurrentProject } from "@squadrant/core";

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
          const result = await dispatchToSibling({
            fromProject,
            toProject,
            task,
            provider: opts.provider,
            mode: opts.mode,
            warmupTimeoutMs: opts.warmupTimeout,
            bootCaptain: async (project) => {
              try {
                execSync(`squadrant launch ${project}`, { stdio: "ignore", timeout: 15_000 });
              } catch {
                throw new Error(`failed to launch captain for '${project}' — is squadrant installed?`);
              }
            },
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
