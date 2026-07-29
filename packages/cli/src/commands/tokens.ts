import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveHome } from "@squadrant/shared";

/**
 * Attributes token spend across captain vs crews, and boot prefix vs
 * accumulated conversation, from real Claude Code transcripts
 * (~/.claude/projects/<slug>/*.jsonl — see docs/specs/2026-07-28-captain-context-budget.md).
 *
 * Claude-only today: transcript format (jsonl usage blocks) is Claude Code
 * specific. squadrant is multi-agent, but no other driver writes an
 * equivalent transcript yet, so this reads Claude transcripts directly
 * rather than through a speculative reader interface for a second
 * implementation that doesn't exist.
 */

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export interface AssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Pure. Parse one raw JSONL transcript line into usage numbers, or null if
 *  the line isn't a valid assistant message with a usage block (user turns,
 *  tool-result lines, and unparsable lines all return null). */
export function parseAssistantUsage(rawLine: string): AssistantUsage | null {
  const line = rawLine.trim();
  if (!line) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = obj as { type?: string; message?: { role?: string; usage?: Record<string, number> } };
  if (entry?.type !== "assistant" || entry.message?.role !== "assistant") return null;
  const usage = entry.message?.usage;
  if (!usage) return null;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

export interface Turn {
  /** input + cache_creation + cache_read for this call — the full context sent. */
  total: number;
  cacheRead: number;
}

export interface SessionAggregate {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** One entry per unique turn — consecutive calls with an identical
   *  cache_read are retries of the same turn and collapse into one entry
   *  (confirmed against a real transcript: turn-2 cache_read reproduces
   *  turn-1's total exactly once retries are collapsed). */
  turns: Turn[];
}

export function emptySessionAggregate(): SessionAggregate {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: [] };
}

/** Mutates `agg` with one raw transcript line. `state.lastCacheRead` tracks
 *  the previous call's cache_read across the whole session so consecutive
 *  retries collapse into a single turn. */
export function foldAssistantLine(
  agg: SessionAggregate,
  rawLine: string,
  state: { lastCacheRead: number | null },
): void {
  const usage = parseAssistantUsage(rawLine);
  if (!usage) return;
  agg.calls++;
  agg.input += usage.input;
  agg.output += usage.output;
  agg.cacheRead += usage.cacheRead;
  agg.cacheWrite += usage.cacheWrite;
  if (usage.cacheRead !== state.lastCacheRead) {
    state.lastCacheRead = usage.cacheRead;
    agg.turns.push({ total: usage.input + usage.cacheWrite + usage.cacheRead, cacheRead: usage.cacheRead });
  }
}

/** Pure. Aggregate an in-memory list of raw JSONL lines — this is what unit
 *  tests exercise against fixture lines. Real transcripts go through
 *  `aggregateTranscriptFile` instead, which streams instead of holding the
 *  whole file in memory. */
export function aggregateLines(lines: Iterable<string>): SessionAggregate {
  const agg = emptySessionAggregate();
  const state = { lastCacheRead: null as number | null };
  for (const line of lines) foldAssistantLine(agg, line, state);
  return agg;
}

/** Streams one transcript file line-by-line (never loads the whole file
 *  into memory — transcripts in this repo run up to ~5.7MB each). */
export async function aggregateTranscriptFile(filePath: string): Promise<SessionAggregate> {
  const agg = emptySessionAggregate();
  const state = { lastCacheRead: null as number | null };
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    foldAssistantLine(agg, line, state);
  }
  return agg;
}

/** Pure. Mirrors Claude Code's own transcript-path escaping (also used by
 *  `deriveTranscriptPath` in packages/agents/src/interactive/claude.ts):
 *  every non-alphanumeric character in the cwd becomes "-". */
export function escapeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Pure. A crew worktree's escaped cwd is the captain's slug plus the
 *  escaped worktree subpath, which always starts with "-" (from the path
 *  separator) — so "<captainSlug>-" is a safe, worktreeDir-agnostic prefix
 *  that can't collide with an unrelated project slug that merely shares a
 *  string prefix (that project's next character would not be "-"). */
export function isCrewDirName(dirName: string, captainSlug: string): boolean {
  return dirName !== captainSlug && dirName.startsWith(`${captainSlug}-`);
}

export interface RoleReport {
  role: "captain" | "crews";
  sessionFiles: number;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Total context per call (input + cache_read + cache_write), averaged. */
  meanCacheReadPerCall: number | null;
  /** Mean turn-1 total across sessions — the fixed boot prefix. */
  meanBoot: number | null;
  /** meanCacheReadPerCall - meanBoot: the accumulated-conversation portion. */
  accumulated: number | null;
  accumulatedPct: number | null;
  /** Sessions where turn-2 cache_read reproduces turn-1 total within 2%,
   *  confirming the boot-prefix reading (see captain-context-budget.md §3). */
  bootConfirmedSessions: number;
  bootSampledSessions: number;
}

/** Pure. Rolls per-session aggregates into one role-level report (captain or
 *  crews) — boot/accumulation math lives here, not spread across callers. */
export function buildRoleReport(role: RoleReport["role"], sessions: SessionAggregate[]): RoleReport {
  let calls = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const boots: number[] = [];
  let bootConfirmedSessions = 0;

  for (const s of sessions) {
    calls += s.calls;
    input += s.input;
    output += s.output;
    cacheRead += s.cacheRead;
    cacheWrite += s.cacheWrite;

    const [first, second] = s.turns;
    if (first) {
      boots.push(first.total);
      if (second && first.total > 0) {
        const rel = Math.abs(second.cacheRead - first.total) / first.total;
        if (rel < 0.02) bootConfirmedSessions++;
      }
    }
  }

  const meanCacheReadPerCall = calls > 0 ? cacheRead / calls : null;
  const meanBoot = boots.length > 0 ? boots.reduce((a, b) => a + b, 0) / boots.length : null;
  const accumulated = meanCacheReadPerCall !== null && meanBoot !== null ? meanCacheReadPerCall - meanBoot : null;
  const accumulatedPct =
    accumulated !== null && meanCacheReadPerCall ? accumulated / meanCacheReadPerCall : null;

  return {
    role,
    sessionFiles: sessions.length,
    calls,
    input,
    output,
    cacheRead,
    cacheWrite,
    meanCacheReadPerCall,
    meanBoot,
    accumulated,
    accumulatedPct,
    bootConfirmedSessions,
    bootSampledSessions: boots.length,
  };
}

export interface ProjectTokenReport {
  project: string;
  path: string;
  captain: RoleReport;
  crews: RoleReport;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdirSafe(dir);
  return entries.filter((e) => e.endsWith(".jsonl")).map((e) => path.join(dir, e));
}

/** Splits `~/.claude/projects/*` into the one captain dir (exact slug match)
 *  and every crew worktree dir for a given project path. */
async function findTranscriptDirs(
  claudeProjectsDir: string,
  captainSlug: string,
): Promise<{ captainDirs: string[]; crewDirs: string[] }> {
  const entries = await readdirSafe(claudeProjectsDir);
  const captainDirs: string[] = [];
  const crewDirs: string[] = [];
  for (const entry of entries) {
    if (entry === captainSlug) captainDirs.push(path.join(claudeProjectsDir, entry));
    else if (isCrewDirName(entry, captainSlug)) crewDirs.push(path.join(claudeProjectsDir, entry));
  }
  return { captainDirs, crewDirs };
}

/** Sequential by design: streams one file at a time so this never opens
 *  more than one read stream (and never holds more than one file's lines)
 *  at once, even across a project with 100+ crew worktree transcripts. */
async function aggregateFiles(files: string[]): Promise<SessionAggregate[]> {
  const sessions: SessionAggregate[] = [];
  for (const file of files) {
    sessions.push(await aggregateTranscriptFile(file));
  }
  return sessions;
}

export async function collectProjectTokenReport(
  name: string,
  projectPath: string,
  claudeProjectsDir: string = CLAUDE_PROJECTS_DIR,
): Promise<ProjectTokenReport> {
  const captainSlug = escapeClaudeProjectPath(projectPath);
  const { captainDirs, crewDirs } = await findTranscriptDirs(claudeProjectsDir, captainSlug);

  const captainFiles = (await Promise.all(captainDirs.map(listJsonlFiles))).flat();
  const crewFiles = (await Promise.all(crewDirs.map(listJsonlFiles))).flat();

  const [captainSessions, crewSessions] = await Promise.all([
    aggregateFiles(captainFiles),
    aggregateFiles(crewFiles),
  ]);

  return {
    project: name,
    path: projectPath,
    captain: buildRoleReport("captain", captainSessions),
    crews: buildRoleReport("crews", crewSessions),
  };
}

/** Pure. "1234567" -> "1.2M", "12345" -> "12.3k", else raw integer string. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatPct(n: number | null): string {
  return n === null ? "n/a" : `${Math.round(n * 100)}%`;
}

function printRoleRow(label: string, r: RoleReport): void {
  const totalVolume = r.input + r.output + r.cacheRead + r.cacheWrite;
  console.log(
    `  ${label.padEnd(10)} ${String(r.sessionFiles).padStart(6)} ${String(r.calls).padStart(8)} ` +
      `${formatTokens(r.input).padStart(8)} ${formatTokens(r.output).padStart(8)} ` +
      `${formatTokens(r.cacheRead).padStart(10)} ${formatTokens(r.cacheWrite).padStart(10)} ` +
      `${formatTokens(totalVolume).padStart(10)}`,
  );
}

function printBootLine(label: string, r: RoleReport): void {
  if (r.meanBoot === null || r.meanCacheReadPerCall === null) {
    console.log(chalk.dim(`  ${label.padEnd(10)} no sessions with turn data`));
    return;
  }
  const bootPct = r.meanCacheReadPerCall > 0 ? r.meanBoot / r.meanCacheReadPerCall : null;
  console.log(
    `  ${label.padEnd(10)} mean ctx/call ${formatTokens(r.meanCacheReadPerCall).padStart(8)}` +
      `  boot ${formatTokens(r.meanBoot).padStart(8)} (${formatPct(bootPct)})` +
      `  accumulated ${formatTokens(r.accumulated ?? 0).padStart(8)} (${formatPct(r.accumulatedPct)})` +
      chalk.dim(`  [boot confirmed ${r.bootConfirmedSessions}/${r.bootSampledSessions} sessions]`),
  );
}

function sumRoleReports(role: RoleReport["role"], reports: RoleReport[]): RoleReport {
  const calls = reports.reduce((a, r) => a + r.calls, 0);
  const cacheRead = reports.reduce((a, r) => a + r.cacheRead, 0);
  const bootWeighted = reports.reduce(
    (a, r) => a + (r.meanBoot !== null ? r.meanBoot * r.bootSampledSessions : 0),
    0,
  );
  const bootSampledSessions = reports.reduce((a, r) => a + r.bootSampledSessions, 0);
  const meanBoot = bootSampledSessions > 0 ? bootWeighted / bootSampledSessions : null;
  const meanCacheReadPerCall = calls > 0 ? cacheRead / calls : null;
  const accumulated = meanCacheReadPerCall !== null && meanBoot !== null ? meanCacheReadPerCall - meanBoot : null;
  const accumulatedPct =
    accumulated !== null && meanCacheReadPerCall ? accumulated / meanCacheReadPerCall : null;

  return {
    role,
    sessionFiles: reports.reduce((a, r) => a + r.sessionFiles, 0),
    calls,
    input: reports.reduce((a, r) => a + r.input, 0),
    output: reports.reduce((a, r) => a + r.output, 0),
    cacheRead,
    cacheWrite: reports.reduce((a, r) => a + r.cacheWrite, 0),
    meanCacheReadPerCall,
    meanBoot,
    accumulated,
    accumulatedPct,
    bootConfirmedSessions: reports.reduce((a, r) => a + r.bootConfirmedSessions, 0),
    bootSampledSessions,
  };
}

export const tokensCommand = new Command("tokens")
  .description(
    "Attribute token spend across captain vs crews and boot prefix vs accumulated conversation (Claude Code transcripts only)",
  )
  .option("--project <name>", "scope to a single registered project")
  .option("--json", "print machine-readable JSON instead of a table")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const config = loadConfig();
    let entries = Object.entries(config.projects);

    if (opts.project) {
      if (!(opts.project in config.projects)) {
        const known = Object.keys(config.projects).sort().join(", ") || "(no projects registered)";
        console.error(chalk.red(`Unknown project '${opts.project}'. Known projects: ${known}`));
        process.exit(1);
      }
      entries = entries.filter(([name]) => name === opts.project);
    }

    const reports: ProjectTokenReport[] = [];
    for (const [name, project] of entries) {
      reports.push(await collectProjectTokenReport(name, resolveHome(project.path)));
    }

    const active = reports.filter((r) => r.captain.calls > 0 || r.crews.calls > 0);
    const skipped = reports.length - active.length;

    if (opts.json) {
      console.log(JSON.stringify({ projects: active }, null, 2));
      return;
    }

    if (active.length === 0) {
      console.log(chalk.yellow("\nNo Claude Code transcripts found for any registered project.\n"));
      return;
    }

    console.log(chalk.bold("\nToken spend by project (Claude Code transcripts only)\n"));
    console.log(chalk.dim(`  ${"PROJECT/ROLE".padEnd(10)} ${"FILES".padStart(6)} ${"CALLS".padStart(8)} ` +
      `${"INPUT".padStart(8)} ${"OUTPUT".padStart(8)} ${"CACHE_READ".padStart(10)} ${"CACHE_WRITE".padStart(10)} ${"TOTAL".padStart(10)}`));
    console.log(chalk.dim("  " + "─".repeat(78)));

    for (const r of active) {
      console.log(chalk.bold(`  ${r.project}`));
      if (r.captain.calls > 0) printRoleRow("captain", r.captain);
      if (r.crews.calls > 0) printRoleRow("crews", r.crews);
    }

    const totalCaptain = sumRoleReports("captain", active.map((r) => r.captain));
    const totalCrews = sumRoleReports("crews", active.map((r) => r.crews));

    console.log(chalk.dim("  " + "─".repeat(78)));
    console.log(chalk.bold("  TOTAL"));
    printRoleRow("captain", totalCaptain);
    printRoleRow("crews", totalCrews);

    console.log(chalk.bold("\nBoot prefix vs accumulated conversation\n"));
    printBootLine("captain", totalCaptain);
    printBootLine("crews", totalCrews);

    console.log(
      chalk.dim(
        "\n  cache_read is ~1/10 the price of fresh input — do not read the TOTAL column as spend.\n" +
          "  claude-only reader today; squadrant is multi-agent but no other driver writes an equivalent transcript yet.\n",
      ),
    );

    if (skipped > 0) {
      console.log(chalk.dim(`  ${skipped} project(s) with no local Claude transcripts omitted.\n`));
    }
  });
