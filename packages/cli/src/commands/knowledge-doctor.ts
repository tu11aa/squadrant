// packages/cli/src/commands/knowledge-doctor.ts — `squadrant knowledge doctor [kb] [--fix]` (#979 phase 2 §5, C3):
// is each KB repo clean after squadrant writes? Mechanical fixes run on --fix; outside edits need a y/n.
import fs from "node:fs";
import readline from "node:readline/promises";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, kbConfigs, KB_NAME_RE, DEFAULT_CONFIG_PATH } from "@squadrant/shared";
import { checkKbRepo, fixKbRepo, kbDir, type KbRepoCheck, type KbRepoFix } from "@squadrant/core";

export interface KbDoctorEntry { check: KbRepoCheck; fix?: KbRepoFix }

/** Phase 2 §5 / C3: is each KB repo clean? --fix runs the mechanical fixes; other changes are committed only on `confirm`. */
export function runKnowledgeDoctor(
  kb: string | undefined, o: { fix?: boolean; confirm?: (kb: string, files: string[]) => boolean } = {}, configPath = DEFAULT_CONFIG_PATH,
): KbDoctorEntry[] {
  const cfg = loadConfig(configPath);
  const kbs = kb ? [kb] : Object.keys(kbConfigs(cfg)).filter((k) => KB_NAME_RE.test(k)); // `_user`: squadrant profile list --check
  return kbs.map((k) => {
    if (!KB_NAME_RE.test(k)) throw new Error(`Invalid knowledge base name '${k}' (use lowercase letters, digits, '-')`);
    const root = kbDir(cfg, k);
    if (!fs.existsSync(root)) throw new Error(`Knowledge base '${k}' does not exist. Run: squadrant knowledge init ${k}`);
    if (!o.fix) return { check: checkKbRepo(k, root) };
    const fix = fixKbRepo(k, root, { confirm: o.confirm && ((files) => o.confirm!(k, files)) });
    return { check: checkKbRepo(k, root), fix };
  });
}

export function renderKbDoctor(entries: KbDoctorEntry[]): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  for (const { check: c, fix } of entries) {
    for (const f of fix?.fixed ?? []) lines.push(chalk.green(`  fixed ${c.kb}: ${f}`));
    for (const f of fix?.committed ?? []) lines.push(chalk.green(`  committed ${c.kb}: ${f}`));
    for (const w of fix?.warnings ?? []) lines.push(chalk.yellow(`  ! ${w}`));
    const problems = [
      ...(c.notRepo ? [`${c.root} is not a git repo`] : []),
      ...(c.missingIgnores.length ? [`.gitignore lacks ${c.missingIgnores.join(", ")}`] : []),
      ...(c.trackedNeverCommitted.length ? [`tracked but never committed (D7): ${c.trackedNeverCommitted.join(", ")}`] : []),
      ...(c.uncommitted.length ? [`uncommitted: ${c.uncommitted.join(", ")}`] : []),
    ];
    if (problems.length) ok = false;
    lines.push(problems.length ? chalk.red(`✘ ${c.kb}: ${problems.join("; ")}`) : chalk.green(`✔ ${c.kb}: clean`));
  }
  if (!ok) lines.push(chalk.dim("fix: squadrant knowledge doctor [kb] --fix (uncommitted item files are committed only after a y/n on a terminal, never from a crew session)"));
  return { lines, ok };
}

export const knowledgeDoctorCommand = new Command("doctor")
  .argument("[kb]")
  .description("Check that each KB repo is clean (D7 .gitignore, nothing tracked that is never committed, no uncommitted files); --fix repairs it")
  .option("--fix", "ensure .gitignore and untrack never-committed files (commits that); asks before committing other uncommitted files")
  .action(async (kb: string | undefined, o: { fix?: boolean }) => {
    const interactive = !!o.fix && !!process.stdin.isTTY && !process.env.SQUADRANT_CREW_TASK_ID;
    let answers: Map<string, boolean> | undefined;
    if (interactive) {
      // Ask before fixing (fixKbRepo's confirm is synchronous): one y/n per KB with outside edits.
      answers = new Map();
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const e of runKnowledgeDoctor(kb)) {
          if (!e.check.uncommitted.length) continue;
          console.log(`${e.check.kb}: changed outside a squadrant write:\n${e.check.uncommitted.map((f) => `  ${f}`).join("\n")}`);
          answers.set(e.check.kb, (await rl.question("commit them, one commit each (Approved-by: operator)? [y/N] ")).trim().toLowerCase() === "y");
        }
      } finally { rl.close(); }
    }
    const { lines, ok } = renderKbDoctor(runKnowledgeDoctor(kb, { fix: o.fix, confirm: answers && ((k) => answers!.get(k) === true) }));
    for (const l of lines) console.log(l);
    if (!ok) process.exitCode = 1;
  });
