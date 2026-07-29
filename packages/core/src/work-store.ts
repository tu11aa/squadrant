// The user's work-item store — durable, per-project JSON, outside the
// daemon's state/ dir on purpose (spec §4.1): sweep() never sees these
// records, so work items survive daemon downtime.
//
// Mirrors store.ts's createStore (atomic write+rename, path-traversal guard,
// TTL GC) rather than sharing it. The spec's preferred route was generalizing
// createStore<T>, but ReturnType<typeof createStore> is embedded in
// DaemonContext.store and re-derived across ~10 daemon-core files (attach.ts,
// delivery-loop.ts, gates.ts, probes.ts, start.ts, squadrantd.ts) — TS does
// not apply createStore's default type param through that ReturnType alias,
// so making it generic breaks all of them (confirmed via `pnpm build`, not
// speculation: see PR description). That is real daemon-core blast radius
// for a task scoped to be a minimal, standalone primitive — out of bounds
// here, so this duplicates the ~20-line guard instead of risking it.
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync,
  rmSync, statSync,
} from "node:fs";
import type { WorkItem, WorkState } from "@squadrant/shared";

/** done/cancelled items are deleted 30 days after closedAt (spec §4.4). */
export const WORK_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function defaultWorkRoot(): string {
  return join(homedir(), ".config", "squadrant", "work");
}

export interface WorkStore {
  put(item: WorkItem): void;
  get(project: string, id: string): WorkItem | undefined;
  list(project: string): WorkItem[];
  listAll(): WorkItem[];
  delete(project: string, id: string): void;
}

// Same guard as store.ts's safeSegment/assertUnderRoot: project/id become a
// path segment, so a crafted value ("..", "/", NUL) must never escape root.
function safeSegment(kind: "project" | "id", s: unknown): string {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error(`invalid ${kind}: must be a non-empty string`);
  }
  if (s.includes("\0")) throw new Error(`invalid ${kind}: NUL byte not allowed`);
  if (s === "." || s === ".." || /[/\\]/.test(s)) {
    throw new Error(`invalid ${kind}: '${s}' — path separators/traversal not allowed`);
  }
  return s;
}

export function createWorkStore(root: string = defaultWorkRoot()): WorkStore {
  const rootResolved = resolve(root);

  const assertUnderRoot = (target: string): string => {
    const r = resolve(target);
    if (r !== rootResolved && !r.startsWith(rootResolved + sep)) {
      throw new Error(`path escapes state root: ${target}`);
    }
    return target;
  };

  const projDir = (p: string) => assertUnderRoot(join(root, safeSegment("project", p)));
  const itemFile = (p: string, id: string) =>
    assertUnderRoot(join(projDir(p), `${safeSegment("id", id)}.json`));

  return {
    put(item) {
      mkdirSync(projDir(item.project), { recursive: true });
      const dest = itemFile(item.project, item.id);
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, JSON.stringify(item, null, 2));
      renameSync(tmp, dest); // atomic replace
    },
    get(project, id) {
      const f = itemFile(project, id);
      if (!existsSync(f)) return undefined;
      try {
        return JSON.parse(readFileSync(f, "utf-8")) as WorkItem;
      } catch {
        return undefined; // corrupt file: caller sees "not found"
      }
    },
    list(project) {
      const d = projDir(project);
      if (!existsSync(d)) return [];
      return readdirSync(d)
        .filter((n) => n.endsWith(".json") && !n.endsWith(".json.tmp"))
        .map((n) => {
          try { return JSON.parse(readFileSync(join(d, n), "utf-8")) as WorkItem; }
          catch { return undefined; }
        })
        .filter((r): r is WorkItem => r !== undefined);
    },
    listAll() {
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .filter((p) => { try { return statSync(join(root, p)).isDirectory(); } catch { return false; } })
        .flatMap((p) => this.list(p));
    },
    delete(project, id) {
      const f = itemFile(project, id);
      if (existsSync(f)) rmSync(f);
    },
  };
}

/** Deletes done/cancelled items whose closedAt is older than the 30-day TTL.
 *  Called lazily on every `work` CLI invocation (spec §4.4) — purge is not
 *  wired into the daemon sweep, so work tracking never depends on the daemon
 *  being up. `now` is injectable so tests don't need to wait 30 real days. */
export function purgeExpiredWorkItems(store: WorkStore, now: number = Date.now()): number {
  let purged = 0;
  for (const item of store.listAll()) {
    if (item.closedAt !== null && now - item.closedAt > WORK_ITEM_TTL_MS) {
      store.delete(item.project, item.id);
      purged++;
    }
  }
  return purged;
}

/** Generates a short, human-typeable id ("w_3f2a") unique across every
 *  project in the store — `work done <id>` takes no --project, so ids must
 *  be globally unique to be looked up alone. */
function generateWorkId(store: WorkStore): string {
  const existing = new Set(store.listAll().map((i) => i.id));
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `w_${randomBytes(2).toString("hex")}`;
    if (!existing.has(id)) return id;
  }
  throw new Error("could not generate a unique work item id");
}

export interface CreateWorkItemOpts {
  project: string;
  title: string;
  parent?: string | null;
  tags?: string[];
  now?: number;
}

export function createWorkItem(store: WorkStore, opts: CreateWorkItemOpts): WorkItem {
  const now = opts.now ?? Date.now();
  const item: WorkItem = {
    id: generateWorkId(store),
    project: opts.project,
    title: opts.title,
    state: "working",
    parent: opts.parent ?? null,
    tags: opts.tags ?? [],
    note: "",
    crewTaskIds: [],
    issue: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  store.put(item);
  return item;
}

/** Finds a work item by id alone, across every project — the shape every
 *  id-only CLI verb (done/cancel) needs (spec §4.5 commands take no
 *  --project for these). */
export function findWorkItemById(store: WorkStore, id: string): WorkItem | undefined {
  return store.listAll().find((i) => i.id === id);
}

export type TerminalWorkState = Extract<WorkState, "done" | "cancelled">;

export interface CloseWorkItemOpts {
  note?: string;
  now?: number;
}

/** Transitions an item to a terminal state (done/cancelled) and stamps
 *  closedAt, which is what the TTL purge keys off. Only the user closes an
 *  item (spec §4.6) — this function has no notion of "who"; that rule is
 *  enforced by the CLI requiring an explicit id, not by this layer. */
export function closeWorkItem(
  store: WorkStore,
  id: string,
  state: TerminalWorkState,
  opts: CloseWorkItemOpts = {},
): WorkItem | undefined {
  const item = findWorkItemById(store, id);
  if (!item) return undefined;
  const now = opts.now ?? Date.now();
  const updated: WorkItem = {
    ...item,
    state,
    note: opts.note ?? item.note,
    updatedAt: now,
    closedAt: now,
  };
  store.put(updated);
  return updated;
}
