// migrate.ts — #983 6b: `squadrant migrate kb`, the one-shot KB spec §10 storage move;
// #998: `squadrant migrate path`, and both sweep references to the paths they move.
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, archiveRoot } from "@squadrant/shared";
import { migrateKb, migratePath, type MigrateKbEntry } from "../lib/migrate-kb.js";
import { moveMap, refSites, sweepRefs, type RefHit } from "../lib/ref-sweep.js";

export const migrateCommand = new Command("migrate").description("One-shot storage migrations (never delete; print a report)");

const SWEEP_SITES = "agent native memory, workspace handoffs, KB repos and project CLAUDE.md/AGENTS.md/GEMINI.md";

function printReport(rows: MigrateKbEntry[], refs: RefHit[]): void {
  for (const e of rows) console.log(`${e.action.padEnd(13)} ${e.kb}: ${e.from} -> ${e.to || "-"}${e.note ? chalk.dim(` (${e.note})`) : ""}`);
  for (const r of refs) console.log(`${r.action.padEnd(13)} ref ${r.site}: ${r.file}:${r.line} ${r.old} -> ${r.new}`);
  if (refs.some((r) => r.action === "rewritten")) console.log(chalk.dim(`originals of rewritten files: ${archiveRoot()}/<date>/ref-sweep/`));
}

migrateCommand
  .command("kb")
  .description(`Move spoke exchange to ~/squadrant/workspace/<p>/, archive retired hub files and the legacy ~/.config/squadrant state (once the daemon has copied it into ~/.local/state/squadrant) under ~/squadrant/archive/<date>/, and run the legacy KB move (\`knowledge migrate\`). Then rewrite references to the moved paths in ${SWEEP_SITES}. Never deletes; idempotent.`)
  .option("--dry-run", "show what would move and which references would be rewritten")
  .action((opts: { dryRun?: boolean }) => {
    const cfg = loadConfig();
    const report = migrateKb(cfg, { dryRun: opts.dryRun });
    const refs = sweepRefs(moveMap(report), refSites(cfg), { dryRun: opts.dryRun });
    if (!report.length) console.log("Nothing to migrate: no spoke exchange, retired hub files, legacy daemon state or legacy knowledge bases found.");
    printReport(report, refs);
  });

migrateCommand
  .command("path <from> <to>")
  .description(`Move a file or dir you made (merged file by file; an existing target file is skipped, never overwritten), then rewrite references to it in ${SWEEP_SITES}. If <from> is already gone and <to> exists, only rewrites the references. Rewritten files are backed up under ~/squadrant/archive/<date>/ref-sweep/. Never deletes; idempotent.`)
  .option("--dry-run", "show what would move and which references would be rewritten")
  .action((from: string, to: string, opts: { dryRun?: boolean }) => {
    let result: ReturnType<typeof migratePath>;
    try {
      result = migratePath(loadConfig(), from, to, { dryRun: opts.dryRun });
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
      return;
    }
    if (!result.rows.length && !result.refs.length) console.log("Nothing to do: nothing left to move and no references to rewrite.");
    printReport(result.rows, result.refs);
  });
