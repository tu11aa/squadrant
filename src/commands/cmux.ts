// src/commands/cmux.ts
//
// cockpit cmux autoconfig — #348 (part of #332). User-facing surface for the
// cmux socket auto-config: write the comment-preserving automation config, probe
// the live socket from a non-cmux process, and tell the user whether a cmux
// restart is needed to enable daemon-direct delivery.
//
// See docs/specs/2026-06-16-cmux-socket-auth-daemon-direct-design.md §4.
import { Command } from "commander";
import chalk from "chalk";
import { ensureCmuxAutoConfig, type AutoConfigResult } from "@cockpit/shared";

export interface CmuxAutoconfigOpts {
  json: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Injectable for tests. Default = ensureCmuxAutoConfig (real I/O). */
  run?: () => Promise<AutoConfigResult>;
}

/** Returns exit code: 0=reachable, 1=unknown/error, 2=restart needed. */
export async function runCmuxAutoconfig(opts: CmuxAutoconfigOpts): Promise<number> {
  const { json, stdout, stderr } = opts;
  let r: AutoConfigResult;
  try {
    r = await (opts.run ?? ensureCmuxAutoConfig)();
  } catch (e) {
    stderr.write(`cmux autoconfig failed: ${(e as Error).message}\n`);
    return 1;
  }

  if (json) {
    stdout.write(JSON.stringify(r) + "\n");
    return r.verdict === "reachable" ? 0 : r.needsRestart ? 2 : 1;
  }

  if (r.configChanged) {
    stdout.write(`wrote cmux automation config → ${r.configPath}\n`);
  } else {
    stdout.write(chalk.dim(`cmux automation config already in place (${r.configPath})\n`));
  }

  if (r.verdict === "reachable") {
    stdout.write(chalk.green("✔ daemon-direct delivery is reachable — cmux control socket accepts the daemon\n"));
    return 0;
  }

  if (r.needsRestart) {
    stdout.write(
      chalk.yellow("⚠ cmux is still on the old socket mode — restart cmux to enable daemon-direct delivery.\n"),
    );
    if (r.promptedThisRun) {
      stdout.write(chalk.dim("  (one-time prompt — you won't be nagged again)\n"));
    }
    return 2;
  }

  // unknown — fail soft.
  stderr.write(
    "could not reach the cmux control socket (is cmux installed and running?) — staying on the relay.\n",
  );
  return 1;
}

export const cmuxCommand = new Command("cmux")
  .description("cmux integration helpers")
  .addCommand(
    new Command("autoconfig")
      .description(
        "Write the cmux automation socket config and probe whether daemon-direct\n" +
        "delivery is reachable. Idempotent; prompts once if a cmux restart is needed.",
      )
      .option("--json", "output machine-readable JSON (exit 0=reachable, 1=unknown, 2=restart-needed)")
      .action(async (opts: { json?: boolean }) => {
        const code = await runCmuxAutoconfig({
          json: opts.json ?? false,
          stdout: process.stdout,
          stderr: process.stderr,
        });
        process.exit(code);
      }),
  );
