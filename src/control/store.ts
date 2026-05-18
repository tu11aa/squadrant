// src/control/store.ts
import {
  mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "./types.js";

export interface Store {
  put(rec: TaskRecord): void;
  get(project: string, id: string): TaskRecord | undefined;
  list(project: string): TaskRecord[];
  listAll(): TaskRecord[];
  quarantine(project: string, id: string): void;
}

export function createStore(root: string): Store {
  const projDir = (p: string) => join(root, p);
  const taskFile = (p: string, id: string) => join(projDir(p), `${id}.json`);

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
        .filter((p) => { try { return statSync(projDir(p)).isDirectory(); } catch { return false; } })
        .flatMap((p) => this.list(p));
    },
    quarantine(project, id) {
      const f = taskFile(project, id);
      // suffix prevents clobber across process restarts
      if (existsSync(f)) renameSync(f, `${f}.corrupt.${Date.now()}`);
    },
  };
}
