// src/commands/group.ts
//
// #246/#367: `squadrant group dispatch` is a DEPRECATED ALIAS for the
// top-level `squadrant dispatch`, which now reaches any registered project
// (not just same-group siblings). Kept working for backward compatibility;
// delegates to dispatch.ts's shared action so behavior stays in one place.

import { Command } from "commander";
import chalk from "chalk";
import { dispatchAction, type DispatchCliOpts } from "./dispatch.js";

export { resolveCurrentProject } from "@squadrant/core";

// ── CLI command ──────────────────────────────────────────────────────────────

export const groupCommand = new Command("group")
  .description("Cross-project intra-group operations (Phase 1: dispatch)")
  .addCommand(
    new Command("dispatch")
      .description("[DEPRECATED — use 'squadrant dispatch'] Dispatch a task to a sibling project in the same group")
      .argument("<to-project>", "Target project name")
      .argument("<task>", "Task description to dispatch")
      .option("--provider <p>", "claude|opencode|codex", "claude")
      .option("--mode <m>", "headless|interactive", "headless")
      .option("--warmup-timeout <s>", "seconds to wait for target captain to boot (default: 120)", (v) => parseInt(v, 10) * 1000)
      .action(async (toProject: string, task: string, opts: DispatchCliOpts) => {
        console.error(chalk.yellow(
          "⚠ 'squadrant group dispatch' is deprecated — use 'squadrant dispatch <project> \"<task>\"' instead.",
        ));
        await dispatchAction(toProject, task, opts);
      }),
  );
