import { Command } from "commander";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { DEFAULT_CONFIG_PATH, getDefaultConfig, type CockpitConfig } from "@cockpit/shared";
import { detectDrift, applySafeFixes, type DriftItem } from "@cockpit/shared";
import { withStamp } from "@cockpit/shared";

export interface ConfigCheckOptions {
  configPath: string;
  pkgVersion: string;
  fix: boolean;
  accept: boolean;
}

export interface ConfigCheckResult {
  items: DriftItem[];
  applied: string[];
  remaining: DriftItem[];
  stamped: boolean;
}

export function runConfigCheck(opts: ConfigCheckOptions): ConfigCheckResult {
  const raw = JSON.parse(fs.readFileSync(opts.configPath, "utf-8")) as CockpitConfig;
  const def = getDefaultConfig();
  const items = detectDrift(raw, def);

  let working = raw;
  let applied: string[] = [];

  if (opts.fix) {
    const r = applySafeFixes(raw, items, def);
    working = r.config;
    applied = r.applied;
  }

  const remaining = detectDrift(working, def);

  let stamped = false;
  if (opts.accept || remaining.length === 0) {
    working = withStamp(working, opts.pkgVersion);
    stamped = true;
  }

  if (opts.fix || opts.accept || stamped) {
    fs.writeFileSync(opts.configPath, JSON.stringify(working, null, 2) + "\n");
  }

  return { items, applied, remaining, stamped };
}

const SEV_COLOR: Record<string, (s: string) => string> = {
  info: chalk.green,
  advisory: chalk.yellow,
  warn: chalk.red,
};
const KIND_GLYPH: Record<string, string> = {
  missing: "+",
  deprecated: "-",
  "changed-default": "~",
  invalid: "\u2717",
};

function printItems(items: DriftItem[]): void {
  for (const i of items) {
    const color = SEV_COLOR[i.severity] ?? ((s: string) => s);
    const detail = i.note ? `  (${i.note})` : i.suggested !== undefined ? `  \u2192 ${JSON.stringify(i.suggested)}` : "";
    console.log("  " + color(`${KIND_GLYPH[i.kind]} ${i.kind}: ${i.path}`) + chalk.dim(detail));
  }
}

export const configCommand = new Command("config").description("Inspect and reconcile cockpit config");

configCommand
  .command("check")
  .description("Detect config drift vs the current default schema")
  .option("--fix", "Apply the safe tier (add missing, remove deprecated)", false)
  .option("--accept", "Stamp the current version without changing config (dismiss advisories)", false)
  .option("--json", "Output drift items as JSON", false)
  .action((opts: { fix: boolean; accept: boolean; json: boolean }) => {
    const pkgVersion = readPkgVersion();
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
      console.log(chalk.yellow("No config found \u2014 run `cockpit init` first."));
      return;
    }
    const res = runConfigCheck({ configPath: DEFAULT_CONFIG_PATH, pkgVersion, fix: opts.fix, accept: opts.accept });

    if (opts.json) {
      console.log(JSON.stringify(res.items, null, 2));
      return;
    }

    if (res.items.length === 0) {
      console.log(chalk.green("\u2714 Config is in sync with the current schema."));
      return;
    }

    console.log(chalk.bold("\nConfig drift:\n"));
    printItems(res.items);

    if (opts.fix && res.applied.length) {
      console.log(chalk.green(`\n\u2714 Applied ${res.applied.length} safe item(s): ${res.applied.join(", ")}`));
    }
    const judgment = res.remaining.filter((i) => i.kind === "changed-default" || i.kind === "invalid");
    if (judgment.length) {
      console.log(chalk.yellow(`\n${judgment.length} item(s) need review \u2014 run the config-doctor skill, or \`cockpit config check --accept\` to keep your values.`));
    } else if (res.stamped) {
      console.log(chalk.green("\n\u2714 Config reconciled and stamped."));
    }
  });

function readPkgVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version as string;
}
