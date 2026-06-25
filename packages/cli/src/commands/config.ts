import { Command } from "commander";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { DEFAULT_CONFIG_PATH, getDefaultConfig, loadConfig, saveConfig, type SquadrantConfig, isDaemonCachedKey } from "@squadrant/shared";
import { detectDrift, applySafeFixes, type DriftItem } from "@squadrant/shared";
import { withStamp } from "@squadrant/shared";
import { restartDaemonIfRunning, type RestartOutcome } from "@squadrant/core";

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
  const raw = JSON.parse(fs.readFileSync(opts.configPath, "utf-8")) as SquadrantConfig;
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

/** Read a value at a dotted path (e.g. "defaults.effort"). Throws if the path
 *  does not resolve. Returns the raw value (stringified by the caller for display). */
export function runConfigGet(key: string, configPath = DEFAULT_CONFIG_PATH): unknown {
  const config = loadConfig(configPath);
  const parts = key.split(".");
  let node: unknown = config;
  for (const p of parts) {
    if (node === null || typeof node !== "object" || !(p in (node as Record<string, unknown>))) {
      throw new Error(`config key not found: ${key}`);
    }
    node = (node as Record<string, unknown>)[p];
  }
  return node;
}

/** Write a value at a dotted path, creating intermediate objects as needed.
 *  The value is JSON-parsed when it parses (numbers/bools/arrays); otherwise the
 *  raw string is kept (so `low` stays "low", not a parse error). Persists to disk.
 *  NOTE: this is a generic local CLI surface; the Telegram channel restricts which
 *  keys may be set via WRITABLE_CONFIG_KEYS, so secrets can't be written remotely. */
export function runConfigSet(key: string, value: string, configPath = DEFAULT_CONFIG_PATH): void {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  const config = loadConfig(configPath) as unknown as Record<string, unknown>;
  const parts = key.split(".");
  let node = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (node[p] === null || typeof node[p] !== "object") node[p] = {};
    node = node[p] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = parsed;
  saveConfig(config as unknown as SquadrantConfig, configPath);
}

function printRestartOutcome(outcome: RestartOutcome): void {
  if (outcome === "skipped-not-running") {
    console.log(chalk.dim("(daemon not running — change applies on next start)"));
  } else if (outcome === "skipped-opt-out") {
    console.log(chalk.dim("(run 'squadrant heal daemon' to apply)"));
  }
}

export function runConfigSetAction(opts: {
  key: string;
  value: string;
  noRestart?: boolean;
  doRestart?: (o: { reason: string; noRestart?: boolean }) => RestartOutcome;
  configPath?: string;
}): void {
  runConfigSet(opts.key, opts.value, opts.configPath);
  console.log(chalk.green(`✔ set ${opts.key} = ${opts.value}`));
  if (isDaemonCachedKey(opts.key)) {
    const doRestart = opts.doRestart ?? restartDaemonIfRunning;
    const outcome = doRestart({ reason: `config ${opts.key}`, noRestart: opts.noRestart });
    printRestartOutcome(outcome);
  }
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

export const configCommand = new Command("config").description("Inspect and reconcile squadrant config");

configCommand
  .command("check")
  .description("Detect config drift vs the current default schema")
  .option("--fix", "Apply the safe tier (add missing, remove deprecated)", false)
  .option("--accept", "Stamp the current version without changing config (dismiss advisories)", false)
  .option("--json", "Output drift items as JSON", false)
  .action((opts: { fix: boolean; accept: boolean; json: boolean }) => {
    const pkgVersion = readPkgVersion();
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
      console.log(chalk.yellow("No config found \u2014 run `squadrant init` first."));
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
      console.log(chalk.yellow(`\n${judgment.length} item(s) need review \u2014 run the config-doctor skill, or \`squadrant config check --accept\` to keep your values.`));
    } else if (res.stamped) {
      console.log(chalk.green("\n\u2714 Config reconciled and stamped."));
    }
  });

configCommand
  .command("get")
  .description("Read a config value by dotted key (e.g. defaults.effort)")
  .argument("<key>", "dotted config key")
  .action((key: string) => {
    try {
      const value = runConfigGet(key);
      console.log(typeof value === "string" ? value : JSON.stringify(value));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }
  });

configCommand
  .command("set")
  .description("Write a config value by dotted key (e.g. defaults.effort low)")
  .argument("<key>", "dotted config key")
  .argument("<value>", "value (JSON-parsed when possible, else a bare string)")
  .option("--no-restart", "skip daemon restart even if the key is daemon-cached")
  .action((key: string, value: string, opts: { restart?: boolean }) => {
    try {
      runConfigSetAction({ key, value, noRestart: opts.restart === false });
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }
  });

function readPkgVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version as string;
}
