import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveHome, TERMINAL_WORK_STATES, type SquadrantConfig, type WorkItem } from "@squadrant/shared";
import {
  createWorkStore,
  createWorkItem,
  closeWorkItem,
  findWorkItemById,
  findOpenChildren,
  purgeExpiredWorkItems,
  type TerminalWorkState,
} from "@squadrant/core";

/** Pure. Resolves the registered project whose path contains `cwd`, if any —
 *  `work list`/`work start` default to it (spec §4.5); `--all`/`--project`
 *  override. */
export function detectCurrentProject(config: SquadrantConfig, cwd: string = process.cwd()): string | undefined {
  for (const [name, proj] of Object.entries(config.projects)) {
    const projPath = resolveHome(proj.path);
    if (cwd === projPath || cwd.startsWith(projPath + path.sep)) return name;
  }
  return undefined;
}

/** Pure. Groups items into top-level roots (parent is null, or points at an
 *  item not in this set) plus a parent-id -> children index. This is the
 *  literal test of the design's point: an incident with no parent — or a
 *  dangling parent — renders flat, not lost. */
export function groupByParent(items: WorkItem[]): { roots: WorkItem[]; childrenOf: Map<string, WorkItem[]> } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const childrenOf = new Map<string, WorkItem[]>();
  const roots: WorkItem[] = [];
  for (const item of items) {
    if (item.parent && byId.has(item.parent)) {
      const list = childrenOf.get(item.parent) ?? [];
      list.push(item);
      childrenOf.set(item.parent, list);
    } else {
      roots.push(item);
    }
  }
  return { roots, childrenOf };
}

/** Pure. The default (non `--include-done`) view hides terminal items — but
 *  hiding a done/cancelled item that still has an unfinished descendant
 *  would orphan that descendant: it'd render as a parentless root with no
 *  sign it belonged to a wave. That defeats the exact scenario --parent
 *  exists for ("wave finished out of order, what's left?"), so a terminal
 *  item stays visible whenever any descendant, at any depth, is still open.
 *  Parent links are resolved from the full (unfiltered) item set so
 *  multi-level chains work. */
export function visibleItems(items: WorkItem[], includeDone: boolean): WorkItem[] {
  if (includeDone) return items;
  const { childrenOf } = groupByParent(items);
  const memo = new Map<string, boolean>();
  const keep = (item: WorkItem): boolean => {
    const cached = memo.get(item.id);
    if (cached !== undefined) return cached;
    memo.set(item.id, false); // cycle guard: a malformed parent chain can't infinite-loop
    const result = !TERMINAL_WORK_STATES.has(item.state) || (childrenOf.get(item.id) ?? []).some(keep);
    memo.set(item.id, result);
    return result;
  };
  return items.filter(keep);
}

function stateColor(state: WorkItem["state"]): (s: string) => string {
  switch (state) {
    case "done": return chalk.green;
    case "cancelled": return chalk.dim;
    case "blocked": return chalk.red;
    case "paused": return chalk.yellow;
    default: return chalk.cyan;
  }
}

function printItem(item: WorkItem, indent: number): void {
  const color = stateColor(item.state);
  const line =
    "  ".repeat(indent) +
    `${chalk.dim(item.id)}  ${item.title}  ${color(`[${item.state}]`)}` +
    (indent === 0 ? chalk.dim(`  (${item.project})`) : "");
  // A terminal item only survives the default (non --include-done) view when
  // it still has an open descendant (see visibleItems) — dim it so it reads
  // as "closed, kept for context" rather than an active item.
  console.log(TERMINAL_WORK_STATES.has(item.state) ? chalk.dim(line) : line);
}

function printTree(items: WorkItem[]): void {
  const { roots, childrenOf } = groupByParent(items);
  const walk = (item: WorkItem, depth: number) => {
    printItem(item, depth);
    for (const child of childrenOf.get(item.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}

function printFlat(items: WorkItem[]): void {
  for (const item of items) printItem(item, 0);
}

const startCmd = new Command("start")
  .description("Start a new work item")
  .argument("<title>", "what you're doing")
  .option("--project <name>", "project this work belongs to (defaults to the current registered project)")
  .option("--parent <id>", "id of the wave/parent item this nests under")
  .option("--tag <tag>", "attach a tag (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .action((title: string, opts: { project?: string; parent?: string; tag: string[] }) => {
    const config = loadConfig();
    const store = createWorkStore();
    purgeExpiredWorkItems(store);

    const project = opts.project ?? detectCurrentProject(config);
    if (!project) {
      console.error(chalk.red("No --project given and cwd is not inside a registered project."));
      process.exit(1);
    }

    if (opts.parent && !findWorkItemById(store, opts.parent)) {
      console.error(chalk.red(`Parent work item '${opts.parent}' not found.`));
      process.exit(1);
    }

    const item = createWorkItem(store, { project, title, parent: opts.parent ?? null, tags: opts.tag });
    console.log(chalk.green(`✓ ${item.id}`) + `  ${item.title}` + chalk.dim(`  (${item.project})`));
  });

const listCmd = new Command("list")
  .description("List work items")
  .option("--project <name>", "scope to one project")
  .option("--all", "list across every project")
  .option("--tree", "render parent/child nesting")
  .option("--include-done", "include done/cancelled items")
  .action((opts: { project?: string; all?: boolean; tree?: boolean; includeDone?: boolean }) => {
    const config = loadConfig();
    const store = createWorkStore();
    purgeExpiredWorkItems(store);

    let items: WorkItem[];
    if (opts.project) {
      items = store.list(opts.project);
    } else if (opts.all) {
      items = store.listAll();
    } else {
      const project = detectCurrentProject(config);
      if (!project) {
        console.error(chalk.red("cwd is not inside a registered project — pass --project or --all."));
        process.exit(1);
      }
      items = store.list(project);
    }

    items = visibleItems(items, opts.includeDone ?? false);

    if (items.length === 0) {
      console.log(chalk.dim("\nNo work items.\n"));
      return;
    }

    console.log();
    if (opts.tree) printTree(items);
    else printFlat(items);
    console.log();
  });

function closeCommand(name: string, state: TerminalWorkState, flag: string, key: "note" | "why", desc: string): Command {
  return new Command(name)
    .description(`Mark a work item ${state}`)
    .argument("<id>", "work item id")
    .option(flag, desc)
    .action((id: string, opts: Record<string, string | undefined>) => {
      const store = createWorkStore();
      purgeExpiredWorkItems(store);

      const item = closeWorkItem(store, id, state, { note: opts[key] });
      if (!item) {
        console.error(chalk.red(`Work item '${id}' not found.`));
        process.exit(1);
      }
      console.log(chalk.green(`✓ ${item.id}`) + `  ${item.title}  ${chalk.dim(`[${item.state}]`)}`);

      // Warn, don't refuse (enforcement is out of scope) — but "done" without
      // this would silently orphan open children in the default list view.
      if (state === "done") {
        const openChildren = findOpenChildren(store, item.id);
        if (openChildren.length > 0) {
          const names = openChildren.map((c) => `${c.id} [${c.state}]`).join(", ");
          console.log(chalk.yellow(`⚠ still has ${openChildren.length} unfinished child item(s): ${names}`));
        }
      }
    });
}

const doneCmd = closeCommand("done", "done", "--note <text>", "note", "closing note");
const cancelCmd = closeCommand("cancel", "cancelled", "--why <text>", "why", "reason");

export const workCommand = new Command("work")
  .description("Track your own in-flight work — persisted, cross-project, cross-session")
  .addCommand(startCmd)
  .addCommand(listCmd)
  .addCommand(doneCmd)
  .addCommand(cancelCmd);
