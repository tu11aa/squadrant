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
  // #599 Phase A: peek at a crew's uncommitted working tree mid-task, instead
  // of the default branch-vs-base review surface. --working shows both panels
  // (VSCode's "Changes" + "Staged Changes" split); --staged/--unstaged show
  // just one. Mutually exclusive; --working wins if more than one is passed.
  staged?: boolean;
  unstaged?: boolean;
  working?: boolean;
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

  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
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

export const diffCommand = new Command("diff")
  .description("Open a crew's branch diff in cmux's native diff viewer — no VSCode required (#596)")
  .argument("<project>", "Project name (must be registered)")
  .argument("<crew>", "Crew name (e.g. crew-1)")
  .option("--layout <mode>", "split (default) or unified", "split")
  .option("--last-turn", "diff only changes since the crew's last agent turn", false)
  .option("--no-focus", "open the diff pane without stealing focus")
  .option("--staged", "show only staged (index) changes — VSCode's 'Staged Changes' panel (#599)", false)
  .option("--unstaged", "show only unstaged working-tree changes — VSCode's 'Changes' panel (#599)", false)
  .option("--working", "show both staged and unstaged changes (mid-task working-tree review, #599)", false)
  .action(runDiff);
