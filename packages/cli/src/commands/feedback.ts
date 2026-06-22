import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { loadConfig, readStamp } from "@squadrant/shared";

const REPO_URL = "https://github.com/tu11aa/squadrant";

// Real running version. Path math is dist-relative and invariant to source
// moves: the bundle lives at dist/index.js, so "../package.json" is the root
// package.json (mirrors readPkgVersion in config.ts and index.ts).
function readPkgVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version as string) ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface Metrics {
  projects?: number;
  launches?: number;
  shutdowns?: number;
  lastUsed?: string;
  [key: string]: unknown;
}

function readMetrics(metricsPath: string): Metrics {
  try {
    return JSON.parse(fs.readFileSync(metricsPath, "utf-8")) as Metrics;
  } catch {
    return {};
  }
}

export function buildIssueUrl(metrics: Metrics, squadrantVersion: string): string {
  const nodeVersion = process.versions.node;
  const platform = process.platform;

  const body = [
    "## Feedback / Bug Report",
    "",
    "**Describe your feedback or issue:**",
    "",
    "<!-- Please describe what happened or what you'd like to see -->",
    "",
    "## Environment",
    "",
    "```",
    `squadrant: ${squadrantVersion}`,
    `node: ${nodeVersion}`,
    `platform: ${platform}`,
    "```",
    "",
    "## Usage Metrics",
    "",
    "```json",
    JSON.stringify(metrics, null, 2),
    "```",
  ].join("\n");

  const params = new URLSearchParams({
    template: "feedback.md",
    title: "[feedback] ",
    body,
  });

  return `${REPO_URL}/issues/new?${params.toString()}`;
}

export const feedbackCommand = new Command("feedback")
  .description("Open a pre-filled GitHub issue for feedback or bug reports")
  .action(() => {
    const config = loadConfig();
    const metricsPath = config.metrics?.path || path.join(os.homedir(), ".config", "squadrant", "metrics.json");
    const metrics = readMetrics(metricsPath);

    const version = readStamp(config) ?? readPkgVersion();
    const issueUrl = buildIssueUrl(metrics, version);

    console.log(chalk.bold("\nOpening feedback issue in browser...\n"));
    console.log(chalk.dim(`  URL: ${issueUrl.substring(0, 80)}...\n`));

    try {
      execSync(`open "${issueUrl}"`, { stdio: "ignore" });
      console.log(chalk.green("  ✔ Browser opened\n"));
    } catch {
      console.log(chalk.yellow("  ⚠ Could not open browser automatically."));
      console.log(`  Open manually: ${chalk.cyan(issueUrl)}\n`);
    }
  });
