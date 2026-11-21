// verify.ts — #1136: `squadrant verify` — local CI-equivalent with SHA-keyed evidence.
// Named `verify` (not `gate`) so it does not collide with the permission gate (`squadrant gate`).
import path from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { runVerify, checkEvidence, changedFiles } from "../lib/verify/run.js";
import { installHook, type HookMode } from "../lib/verify/hook.js";
import { assessRisk, loadRiskMap } from "../lib/verify/risk-map.js";
import { loadVerifyConfig } from "../lib/verify/config.js";
import { git } from "../lib/verify/evidence.js";

const toplevel = (p?: string) => git(path.resolve(p ?? process.cwd()), ["rev-parse", "--show-toplevel"]);

export function verifyCommand(): Command {
  const verify = new Command("verify")
    .description("Run .squadrant/verify.json steps locally and write SHA-keyed evidence (#1136)")
    .option("--repo <path>", "repo to verify (default: cwd)")
    .option("--base <branch>", "base branch for diff-based meta-checks (default: verify.json base or develop)")
    .option("--test-change <reason>", "justify changed assertions in high-tier specs (same as a test-change: commit note)")
    .option("--check", "only verify green evidence exists for HEAD (fast; used by the pre-push check hook)")
    .action((opts: { repo?: string; base?: string; testChange?: string; check?: boolean }) => {
      try {
        const repo = toplevel(opts.repo);
        if (opts.check) {
          const r = checkEvidence(repo);
          console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
          process.exit(r.ok ? 0 : 1);
        }
        const { evidence, file } = runVerify({ repo, base: opts.base, testChange: opts.testChange });
        console.log(fs.readFileSync(file.replace(/\.json$/, ".md"), "utf8"));
        console.log(chalk.dim(`evidence: ${file}`));
        process.exit(evidence.green ? 0 : 1);
      } catch (err) {
        console.error(chalk.red(`verify: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  verify
    .command("install-hook")
    .description("Install a pre-push hook: run = run verify, check = require green evidence for HEAD")
    .requiredOption("--mode <mode>", "run | check")
    .option("--repo <path>", "repo (default: cwd)")
    .action((opts: { mode: string; repo?: string }) => {
      if (opts.mode !== "run" && opts.mode !== "check") {
        console.error(chalk.red("--mode must be run or check"));
        process.exit(1);
      }
      try {
        const r = installHook(toplevel(opts.repo), opts.mode as HookMode);
        console.log(chalk.green(`Installed pre-push (${opts.mode}): ${r.hookPath}`));
        if (r.chained) console.log(chalk.dim(`Chained existing hook: ${r.chained}`));
      } catch (err) {
        console.error(chalk.red(`verify install-hook: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  verify
    .command("risk")
    .description("Print the diff's risk label, touched high-tier invariants and required steps as JSON")
    .option("--base <branch>", "base branch (default: verify.json base or develop)")
    .option("--repo <path>", "repo (default: cwd)")
    .action((opts: { base?: string; repo?: string }) => {
      try {
        const repo = toplevel(opts.repo);
        let cfgBase: string | undefined;
        try { cfgBase = loadVerifyConfig(repo).base; } catch { /* risk works without verify.json */ }
        const files = changedFiles(repo, opts.base ?? cfgBase ?? "develop");
        const r = assessRisk(loadRiskMap(repo), files);
        console.log(JSON.stringify({ label: r.label, files, invariants: r.touchedHigh, requiredSteps: r.requiredSteps }, null, 2));
      } catch (err) {
        console.error(chalk.red(`verify risk: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  return verify;
}
