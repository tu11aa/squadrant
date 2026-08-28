// src/control/store.ts
import {
  mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync,
  rmSync, statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { TERMINAL_STATES } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";

export interface Store {
  put(rec: TaskRecord): void;
  get(project: string, id: string): TaskRecord | undefined;
  list(project: string): TaskRecord[];
  listAll(): TaskRecord[];
  quarantine(project: string, id: string): void;
  delete(project: string, id: string): void;
}

/**
 * SECURITY (red-team #1, Critical): `project`/`id` arrive unsanitized from the
 * socket (dispatch + seed) and a crafted value (`..`, `/`, absolute, NUL) would
 * let a confused-deputy read/write arbitrary files as the user. A `project`/`id`
 * must be a single safe path segment — no separators, traversal, NUL, or dot
 * dirs. Enforced at the one chokepoint every fs op funnels through.
 */
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

export function createStore(root: string): Store {
  const rootResolved = resolve(root);

  // Defense in depth: even after segment validation, never let a resolved
  // path escape the state root.
  const assertUnderRoot = (target: string): string => {
    const r = resolve(target);
    if (r !== rootResolved && !r.startsWith(rootResolved + sep)) {
      throw new Error(`path escapes state root: ${target}`);
    }
    return target;
  };

  const projDir = (p: string) => assertUnderRoot(join(root, safeSegment("project", p)));
  const taskFile = (p: string, id: string) =>
    assertUnderRoot(join(projDir(p), `${safeSegment("id", id)}.json`));

  const readRecord = (project: string, id: string): TaskRecord | undefined => {
    const f = taskFile(project, id);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf-8")) as TaskRecord;
    } catch {
      return undefined; // corrupt file: caller handles (Task 6)
    }
  };

  return {
    put(rec) {
      // #595: the one chokepoint every fs write funnels through — same
      // philosophy as safeSegment above. Every in-process writer is expected
      // to pre-check TERMINAL_STATES itself before calling put(), but that is
      // a convention, not an invariant; a caller that forgets (or a future
      // one that never learns the rule) can silently clobber a terminal
      // record's state/reason with no error and no trace — reported live: a
      // 'cancelled' record silently became 'done'. Enforce it here too, as
      // defense in depth: once a record is terminal, only a transition OUT of
      // terminal (task.reopened → a non-terminal state) may change its
      // state/lastEvent. A same-or-different terminal→terminal write is
      // rejected outright and the original terminal record is preserved.
      const existing = readRecord(rec.project, rec.id);
      if (
        existing &&
        TERMINAL_STATES.has(existing.state) &&
        TERMINAL_STATES.has(rec.state) &&
        (existing.state !== rec.state || existing.lastEvent !== rec.lastEvent)
      ) {
        console.error(
          `[squadrant] REJECTED terminal→terminal overwrite of ${rec.project}/${rec.id}: ` +
            `already ${existing.state}/${existing.lastEvent} — refusing ${rec.state}/${rec.lastEvent}; ` +
            `original terminal record preserved (#595)`,
        );
        return;
      }
      mkdirSync(projDir(rec.project), { recursive: true });
      const dest = taskFile(rec.project, rec.id);
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2));
      renameSync(tmp, dest); // atomic replace
    },
    get(project, id) {
      return readRecord(project, id);
    },
    list(project) {
      const d = projDir(project);
      if (!existsSync(d)) return [];
      return readdirSync(d)
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          try { return JSON.parse(readFileSync(join(d, n), "utf-8")) as TaskRecord; }
          catch { return undefined; }
        })
        .filter((r): r is TaskRecord => r !== undefined);
    },
    listAll() {
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .filter((p) => { try { return statSync(join(root, p)).isDirectory(); } catch { return false; } })
        .flatMap((p) => this.list(p));
    },
    quarantine(project, id) {
      const f = taskFile(project, id);
      // suffix prevents clobber across process restarts
      if (existsSync(f)) renameSync(f, `${f}.corrupt.${Date.now()}`);
    },
    delete(project, id) {
      const f = taskFile(project, id);
      if (existsSync(f)) rmSync(f);
    },
  };
}
