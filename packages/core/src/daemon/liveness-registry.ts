import { writeFileSync, readFileSync, renameSync } from "node:fs";
import type { LivenessEntry } from "@squadrant/shared";
import { reconcileLiveness } from "../liveness.js";

export interface LivenessRegistryOpts {
  path: string;
  readFile?: (p: string) => string | undefined;
  writeFile?: (p: string, content: string) => void;
}

/** Core-owned, disk-persisted registry — the single liveness source of truth. */
export class LivenessRegistry {
  private readonly path: string;
  private readonly readFile: (p: string) => string | undefined;
  private readonly writeFile: (p: string, content: string) => void;
  private map = new Map<string, LivenessEntry>();

  constructor(opts: LivenessRegistryOpts) {
    this.path = opts.path;
    this.readFile = opts.readFile ?? ((p) => { try { return readFileSync(p, "utf-8"); } catch { return undefined; } });
    this.writeFile = opts.writeFile ?? ((p, c) => { writeFileSync(`${p}.tmp`, c); renameSync(`${p}.tmp`, p); });
  }

  load(): void {
    const raw = this.readFile(this.path);
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as LivenessEntry[];
      this.map = new Map(arr.map((e) => [e.project, e]));
    } catch { this.map = new Map(); }
  }

  get(project: string): LivenessEntry | undefined { return this.map.get(project); }
  all(): LivenessEntry[] { return [...this.map.values()]; }

  apply(next: LivenessEntry): void {
    this.map.set(next.project, reconcileLiveness(this.map.get(next.project), next));
    this.persist();
  }

  markEnded(project: string, at: number): void {
    const e = this.map.get(project);
    if (!e) return;
    this.map.set(project, { ...e, lastState: "end", lastSeenAt: at });
    this.persist();
  }

  setPidAlive(project: string, alive: boolean, at: number): void {
    const e = this.map.get(project);
    if (!e) return;
    this.map.set(project, { ...e, pidAlive: alive, lastSeenAt: at });
    this.persist();
  }

  private persist(): void {
    try { this.writeFile(this.path, JSON.stringify(this.all(), null, 2)); } catch { /* best-effort */ }
  }
}
