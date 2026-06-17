import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { loadConfig } from "@cockpit/shared";

const REPO_URL = "https://github.com/tu11aa/claude-cockpit";

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

function buildIssueUrl(metrics: Metrics): string {
  const nodeVersion = process.versions.node;
  const platform = process.platform;
  const cockpitVersion = "0.1.0";

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
    `cockpit: ${cockpitVersion}`,
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
    const metricsPath = config.metrics?.path || path.join(os.homedir(), ".config", "cockpit", "metrics.json");
    const metrics = readMetrics(metricsPath);

    const issueUrl = buildIssueUrl(metrics);

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
