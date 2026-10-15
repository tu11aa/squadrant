// migrate.ts — #983 6b: `squadrant migrate kb`, the one-shot KB spec §10 storage move.
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { migrateKb } from "../lib/migrate-kb.js";

export const migrateCommand = new Command("migrate").description("One-shot storage migrations (never delete; print a report)");

migrateCommand
  .command("kb")
  .description("Move spoke exchange to ~/squadrant/workspace/<p>/, archive retired hub files under ~/squadrant/archive/<date>/, and run the legacy KB move (`knowledge migrate`). Never deletes; idempotent.")
  .option("--dry-run", "show what would move")
  .action((opts: { dryRun?: boolean }) => {
    const report = migrateKb(loadConfig(), { dryRun: opts.dryRun });
    if (!report.length) console.log("Nothing to migrate: no spoke exchange, retired hub files or legacy knowledge bases found.");
    for (const e of report) console.log(`${e.action.padEnd(13)} ${e.kb}: ${e.from} -> ${e.to || "-"}${e.note ? chalk.dim(` (${e.note})`) : ""}`);
  });
