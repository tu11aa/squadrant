import chalk from "chalk";
import type { ProjectStatus, DashboardState } from "./read-status.js";

export interface RenderOptions {
  now: string;          // ISO-8601 string, used for age calc + footer
  width?: number;       // terminal width (defaults to process.stdout.columns or 100)
}

const ICON: Record<DashboardState, (s: string) => string> = {
  idle:    chalk.green,
  busy:    chalk.cyan,
  blocked: chalk.yellow,
  errored: chalk.red,
  offline: chalk.dim,
  unknown: chalk.gray,
};

const ICON_CHAR: Record<DashboardState, string> = {
  idle:    "●",
  busy:    "◐",
  blocked: "⏸",
  errored: "✗",
  offline: "○",
  unknown: "·",
};

export function formatAge(lastChecked: string, now: string): string {
  if (!lastChecked) return "?";
  const t = Date.parse(lastChecked);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return "?";
  const sec = Math.max(0, Math.floor((n - t) / 1000));
  if (sec < 60)        return `${sec}s`;
  if (sec < 60 * 60)   return `${Math.floor(sec / 60)}m`;
  if (sec < 60 * 60 * 24) return `${Math.floor(sec / 3600)}h`;
  return "stale";
}

function firstLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

export function renderDashboard(rows: ProjectStatus[], opts: RenderOptions): string {
  const width = opts.width ?? 100;
  const lines: string[] = [];

  lines.push("");
  lines.push("  " + chalk.bold("📊 Cockpit Dashboard") + "  " + chalk.dim(opts.now));
  lines.push("");

  if (rows.length === 0) {
    lines.push("  " + chalk.yellow("No projects registered. Add one with: cockpit projects add <name> <path>"));
    lines.push("");
    return lines.join("\n");
  }

  // Column widths — fixed for the left side, excerpt fills the remainder.
  const NAME_W  = 16;
  const STATE_W = 8;
  const AGE_W   = 6;
  const FIXED   = 2 /*indent*/ + 1 /*icon*/ + 1 + NAME_W + 1 + STATE_W + 1 + AGE_W + 3 /*│ */;
  const excerptW = Math.max(20, width - FIXED);

  for (const r of rows) {
    const icon = ICON[r.state](ICON_CHAR[r.state]);
    const name = chalk.cyan(pad(r.project, NAME_W));
    const state = ICON[r.state](pad(r.state, STATE_W));
    const age = pad(formatAge(r.lastChecked, opts.now), AGE_W);
    const excerpt = chalk.dim(truncate(firstLine(r.excerpt), excerptW));
    lines.push(`  ${icon} ${name} ${state} ${age} │ ${excerpt}`);
  }

  lines.push("");
  lines.push(chalk.dim("  Refreshes every 10s · Ctrl+C to exit"));
  lines.push("");
  return lines.join("\n");
}
