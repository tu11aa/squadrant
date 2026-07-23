import { Command } from "commander";
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import { loadConfig, crewBranch, resolveWorktreeBase, TERMINAL_STATES } from "@squadrant/shared";
import type { TaskRecord, ProjectConfig } from "@squadrant/shared";
import type { RuntimeDriver } from "@squadrant/shared";
import { resolveCaptainWorkspace } from "@squadrant/workspaces";
import { squadrantdCall } from "./crew-control.js";

/**
 * Pure. Resolve a crew name to the worktree it should diff, applying the same
 * duplicate-record tie-break as runCrewSend/runCrewClose (#574's
 * pickMostRecentTask rule). Returns null when no task record matches the crew
 * name — the caller reports "run crew list" rather than guessing a worktree.
 * A `--shared` crew (spawned without an isolated worktree) records cwd ===
 * projectPath (crew-spawn.ts's spawnCwd), which is how isShared is detected.
 */
export function resolveDiffTarget(
  tasks: TaskRecord[],
  crew: string,
  projectPath: string,
): { cwd: string; isShared: boolean } | null {
  const matches = tasks.filter((t) => t.name === crew);
  if (matches.length === 0) return null;
  const task = matches.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a));
  const cwd = task.cwd ?? projectPath;
  return { cwd, isShared: cwd === projectPath };
}

export interface DiffOptions {
  layout: "split" | "unified";
  lastTurn?: boolean;
  focus: boolean;
  // #599 Phase A: peek at a crew's uncommitted working tree mid-task, instead
  // of the default branch-vs-base review surface. --working shows both panels
  // (VSCode's "Changes" + "Staged Changes" split); --staged/--unstaged show
  // just one. Mutually exclusive; --working wins if more than one is passed.
  staged?: boolean;
  unstaged?: boolean;
  working?: boolean;
  // #604: review a PR (`gh pr diff <n>`), mutually exclusive with crew/base/head.
  pr?: string;
  // #604: compare two arbitrary refs (`git diff base...head`). --against is an
  // alias for --base that diffs against current HEAD (no --head needed).
  base?: string;
  head?: string;
  against?: string;
}

// Pure. Which working-tree sources to open for the given flags, in display
// order. Empty array means "no working-tree flag was passed" — the caller
// falls back to the default branch-vs-base behavior.
export function resolveDiffSources(opts: DiffOptions): Array<"staged" | "unstaged"> {
  if (opts.working) return ["unstaged", "staged"];
  if (opts.staged) return ["staged"];
  if (opts.unstaged) return ["unstaged"];
  return [];
}

export type DiffMode =
  | { mode: "crew"; crew: string }
  | { mode: "pr"; pr: string }
  | { mode: "refs"; base: string; head: string }
  | { mode: "pick" };

/**
 * Pure. Decides which of the four #604 modes a `squadrant diff` invocation
 * requests, and validates they were not combined. `--against <ref>` is sugar
 * for `--base <ref> --head HEAD` — diff the given ref against current HEAD
 * without needing a second flag.
 */
export function resolveDiffMode(
  crew: string | undefined,
  opts: { pr?: string; base?: string; head?: string; against?: string },
): DiffMode {
  const requestedModes = [crew !== undefined, opts.pr !== undefined, opts.base !== undefined || opts.head !== undefined || opts.against !== undefined];
  if (requestedModes.filter(Boolean).length > 1) {
    throw new Error(
      "squadrant diff: a crew argument, --pr, and --base/--head/--against are mutually exclusive.",
    );
  }
  if (opts.against !== undefined && (opts.base !== undefined || opts.head !== undefined)) {
    throw new Error("squadrant diff: --against cannot be combined with --base/--head.");
  }
  if (crew !== undefined) return { mode: "crew", crew };
  if (opts.pr !== undefined) return { mode: "pr", pr: opts.pr };
  if (opts.against !== undefined) return { mode: "refs", base: opts.against, head: "HEAD" };
  if (opts.base !== undefined || opts.head !== undefined) {
    if (opts.base === undefined || opts.head === undefined) {
      throw new Error(
        "squadrant diff: --base and --head must be used together (or use --against <ref> to diff against HEAD).",
      );
    }
    return { mode: "refs", base: opts.base, head: opts.head };
  }
  return { mode: "pick" };
}

export interface CrewDiffStat {
  name: string;
  cwd: string;
  stat: string;
}

/**
 * Pure (given an injected `getStat`). Builds the pick-list for #604 mode 3:
 * one entry per live (non-terminal) named crew, de-duped by name via the same
 * most-recently-created tie-break as resolveDiffTarget/pickMostRecentTask.
 */
export function buildCrewDiffStats(
  tasks: TaskRecord[],
  projectPath: string,
  base: string,
  getStat: (cwd: string, base: string) => string,
): CrewDiffStat[] {
  const live = new Map<string, TaskRecord>();
  for (const t of tasks) {
    if (!t.name || TERMINAL_STATES.has(t.state)) continue;
    const prev = live.get(t.name);
    if (!prev || (t.createdAt ?? 0) > (prev.createdAt ?? 0)) live.set(t.name, t);
  }
  return [...live.values()].map((t) => {
    const cwd = t.cwd ?? projectPath;
    return { name: t.name!, cwd, stat: getStat(cwd, base).trim() };
  });
}

/** Pure. Resolves a user's raw pick-list answer (1-based index or crew name) to a crew name. */
export function parseCrewPick(raw: string, stats: CrewDiffStat[]): string {
  const trimmed = raw.trim();
  const idx = Number(trimmed);
  if (Number.isInteger(idx) && idx >= 1 && idx <= stats.length) {
    return stats[idx - 1].name;
  }
  const byName = stats.find((s) => s.name === trimmed);
  if (byName) return byName.name;
  throw new Error(`Invalid selection '${raw}'. Enter a number 1-${stats.length} or a crew name.`);
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** `gh pr diff <n>` run from the project's root checkout (not a crew worktree — a PR is project-wide). */
function getPrDiff(projectPath: string, pr: string): string {
  try {
    return execFileSync("gh", ["pr", "diff", pr], { cwd: projectPath, encoding: "utf-8" });
  } catch (e) {
    throw new Error(`Could not fetch PR #${pr} diff (gh pr diff failed): ${(e as Error).message}`);
  }
}

/** `git diff <base>...<head>` (merge-base form, consistent with the crew branch-vs-base review). */
function getRefsDiff(projectPath: string, base: string, head: string): string {
  try {
    return execFileSync("git", ["-C", projectPath, "diff", `${base}...${head}`], { encoding: "utf-8" });
  } catch (e) {
    throw new Error(`Could not diff ${base}...${head}: ${(e as Error).message}`);
  }
}

/** Existing crew-review path (#596/#599): branch-vs-base or working-tree peek for one named crew. */
async function openCrewDiff(
  project: string,
  proj: ProjectConfig,
  crew: string,
  opts: DiffOptions,
  runtime: RuntimeDriver,
  workspaceId: string,
): Promise<void> {
  const tasks = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
  const target = resolveDiffTarget(tasks, crew, proj.path);
  if (!target) {
    throw new Error(`Crew '${crew}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }

  const base = resolveWorktreeBase(proj.path);
  const branchLabel = crewBranch(crew);

  if (!runtime.showDiff) {
    throw new Error(`Runtime '${runtime.name}' has no native diff viewer yet — Phase 1 supports cmux only.`);
  }

  const sources = resolveDiffSources(opts);
  if (sources.length > 0) {
    // Working-tree peek (#599): each source is gated on its OWN emptiness —
    // there is no single base...HEAD comparison for uncommitted changes.
    let opened = 0;
    for (const source of sources) {
      const statArgs = source === "staged" ? ["diff", "--stat", "--cached"] : ["diff", "--stat"];
      const stat = execFileSync("git", ["-C", target.cwd, ...statArgs], { encoding: "utf-8" }).trim();
      if (!stat) continue;
      await runtime.showDiff({
        workspaceId,
        cwd: target.cwd,
        base,
        title: `${branchLabel} — ${source}`,
        layout: opts.layout,
        focus: opts.focus,
        source,
      });
      opened++;
    }
    if (opened === 0) {
      const label = sources.length > 1 ? "staged or unstaged" : sources[0];
      console.log(`No ${label} changes on ${branchLabel}.`);
    } else {
      console.log(chalk.dim(`Opened ${opened} working-tree diff(s) (${sources.join(", ")}) for ${branchLabel}.`));
    }
    return;
  }

  // Empty-diff guard (#596): a crew that made no changes yet shouldn't pop a
  // diff viewer with nothing in it. `target.cwd` is already checked out on
  // the right ref for both cases — the crew's own branch in an isolated
  // worktree, or the root checkout's current HEAD for a --shared crew.
  const diffStat = execFileSync(
    "git", ["-C", target.cwd, "diff", "--stat", `${base}...HEAD`],
    { encoding: "utf-8" },
  ).trim();
  if (!diffStat) {
    console.log(`No changes on ${branchLabel} vs ${base}.`);
    return;
  }

  await runtime.showDiff({
    workspaceId,
    cwd: target.cwd,
    base,
    title: `${branchLabel} vs ${base}`,
    layout: opts.layout,
    focus: opts.focus,
    lastTurn: opts.lastTurn,
    source: "branch",
  });
  console.log(chalk.dim(`Opened ${branchLabel} vs ${base} in cmux diff.`));
}

export async function runDiff(project: string, crewArg: string | undefined, opts: DiffOptions): Promise<void> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }

  const mode = resolveDiffMode(crewArg, opts);
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);

  if (mode.mode === "pr" || mode.mode === "refs") {
    if (!runtime.showPatch) {
      throw new Error(`Runtime '${runtime.name}' has no native patch viewer yet — Phase 1 supports cmux only.`);
    }
    const title = mode.mode === "pr" ? `PR #${mode.pr}` : `${mode.base}...${mode.head}`;
    const patch = mode.mode === "pr" ? getPrDiff(proj.path, mode.pr) : getRefsDiff(proj.path, mode.base, mode.head);
    if (!patch.trim()) {
      console.log(`No changes in ${title}.`);
      return;
    }
    await runtime.showPatch({ workspaceId, patch, title, layout: opts.layout, focus: opts.focus });
    console.log(chalk.dim(`Opened ${title} in cmux diff.`));
    return;
  }

  let crew: string;
  if (mode.mode === "pick") {
    const tasks = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
    const base = resolveWorktreeBase(proj.path);
    const stats = buildCrewDiffStats(tasks, proj.path, base, (cwd, b) => {
      try {
        return execFileSync("git", ["-C", cwd, "diff", "--stat", `${b}...HEAD`], { encoding: "utf-8" });
      } catch {
        return "";
      }
    });
    if (stats.length === 0) {
      throw new Error(`No live crews for ${project}. Run 'squadrant crew list ${project}' to check, or 'squadrant crew spawn' one.`);
    }
    console.log(`Live crews for ${project} (vs ${base}):`);
    stats.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} — ${s.stat || "no changes"}`));
    const raw = await promptLine("Pick a crew to diff (number or name): ");
    crew = parseCrewPick(raw, stats);
  } else {
    crew = mode.crew;
  }

  await openCrewDiff(project, proj, crew, opts, runtime, workspaceId);
}

export const diffCommand = new Command("diff")
  .description("Open a crew's branch diff, a PR, or a ref comparison in cmux's native diff viewer — no VSCode required (#596/#604)")
  .argument("<project>", "Project name (must be registered)")
  .argument("[crew]", "Crew name (e.g. crew-1); omit with no other flags to pick from live crews")
  .option("--pr <n>", "Review a PR: wraps `gh pr diff <n>` (mutually exclusive with crew/--base/--head)")
  .option("--base <ref>", "Base ref for a --head ref comparison (merge-base diff)")
  .option("--head <ref>", "Head ref for a --base ref comparison")
  .option("--against <ref>", "Alias: diff <ref>...HEAD (mutually exclusive with --base/--head)")
  .option("--layout <mode>", "split (default) or unified", "split")
  .option("--last-turn", "diff only changes since the crew's last agent turn", false)
  .option("--no-focus", "open the diff pane without stealing focus")
  .option("--staged", "show only staged (index) changes — VSCode's 'Staged Changes' panel (#599)", false)
  .option("--unstaged", "show only unstaged working-tree changes — VSCode's 'Changes' panel (#599)", false)
  .option("--working", "show both staged and unstaged changes (mid-task working-tree review, #599)", false)
  .action(runDiff);
