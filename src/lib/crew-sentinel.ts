import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

export type CrewSignalState = "done" | "blocked";

export interface CrewSentinel {
  project: string;
  crew: string;
  state: CrewSignalState;
  event: string;
  sessionId?: string;
  ts: string;
  excerpt: string;
}

export function crewStateDir(base: string = CONFIG_DIR): string {
  return path.join(base, "state");
}

export function sentinelPath(
  stateDir: string,
  project: string,
  crew: string,
  state: CrewSignalState,
): string {
  return path.join(stateDir, project, `${crew}.${state}.json`);
}

export function writeCrewSentinel(stateDir: string, s: CrewSentinel): void {
  const file = sentinelPath(stateDir, s.project, s.crew, s.state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

export function readCrewSentinels(stateDir: string, project: string): CrewSentinel[] {
  const dir = path.join(stateDir, project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CrewSentinel[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")) as CrewSentinel;
      if (parsed && parsed.crew && (parsed.state === "done" || parsed.state === "blocked")) {
        out.push(parsed);
      }
    } catch {
      // skip corrupt sentinel
    }
  }
  return out;
}

function nudgeMarkerPath(
  stateDir: string,
  project: string,
  crew: string,
  state: CrewSignalState,
): string {
  return path.join(stateDir, project, `${crew}.${state}.nudged`);
}

export function alreadyNudged(stateDir: string, s: CrewSentinel): boolean {
  try {
    return fs.readFileSync(nudgeMarkerPath(stateDir, s.project, s.crew, s.state), "utf-8") === s.ts;
  } catch {
    return false;
  }
}

export function markNudged(stateDir: string, s: CrewSentinel): void {
  const file = nudgeMarkerPath(stateDir, s.project, s.crew, s.state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s.ts);
}
