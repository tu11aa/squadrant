// src/control/store.ts
import {
  mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync,
  statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type { TaskRecord } from "./types.js";

export interface Store {
  put(rec: TaskRecord): void;
  get(project: string, id: string): TaskRecord | undefined;
  list(project: string): TaskRecord[];
  listAll(): TaskRecord[];
  quarantine(project: string, id: string): void;
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

  return {
    put(rec) {
      mkdirSync(projDir(rec.project), { recursive: true });
      const dest = taskFile(rec.project, rec.id);
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2));
      renameSync(tmp, dest); // atomic replace
    },
    get(project, id) {
      const f = taskFile(project, id);
      if (!existsSync(f)) return undefined;
      try {
        return JSON.parse(readFileSync(f, "utf-8")) as TaskRecord;
      } catch {
        return undefined; // corrupt file: caller handles (Task 6)
      }
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
  };
}
