import { Command } from "commander";
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import { loadConfig, crewBranch, resolveWorktreeBase } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
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
}

export async function runDiff(project: string, crew: string, opts: DiffOptions): Promise<void> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }

  const tasks = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
  const target = resolveDiffTarget(tasks, crew, proj.path);
  if (!target) {
    throw new Error(`Crew '${crew}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }

  const base = resolveWorktreeBase(proj.path);
  const branchLabel = crewBranch(crew);

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

  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  if (!runtime.showDiff) {
    throw new Error(`Runtime '${runtime.name}' has no native diff viewer yet — Phase 1 supports cmux only.`);
  }
  await runtime.showDiff({
    workspaceId,
    cwd: target.cwd,
    base,
    title: `${branchLabel} vs ${base}`,
    layout: opts.layout,
    focus: opts.focus,
    lastTurn: opts.lastTurn,
  });
  console.log(chalk.dim(`Opened ${branchLabel} vs ${base} in cmux diff.`));
}

export const diffCommand = new Command("diff")
  .description("Open a crew's branch diff in cmux's native diff viewer — no VSCode required (#596)")
  .argument("<project>", "Project name (must be registered)")
  .argument("<crew>", "Crew name (e.g. crew-1)")
  .option("--layout <mode>", "split (default) or unified", "split")
  .option("--last-turn", "diff only changes since the crew's last agent turn", false)
  .option("--no-focus", "open the diff pane without stealing focus")
  .action(runDiff);
