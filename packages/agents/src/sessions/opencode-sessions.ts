// packages/agents/src/sessions/opencode-sessions.ts
//
// #669: read-only introspection of opencode sessions for `squadrant sessions`.
//
// Opencode stores session metadata in SQLite, so there is no per-session file
// registry to enumerate. The one persisted, squadrant-owned registry opencode
// has is the captain-address record introduced by #786/#789
// (`state/<project>/captain.json`). Crews have no equivalent persisted record
// and are intentionally out of scope for this command.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSession } from "../drivers/types.js";

/** Squadrant's state root — mirrors the CLI/daemon default. */
export const SQUADRANT_STATE_DIR = join(homedir(), ".config", "squadrant", "state");

interface CaptainRecord {
  agent?: string;
  port?: number;
  sessionId?: string;
  directory?: string;
}

export interface OpencodeSessionListDeps {
  /** Defaults to SQUADRANT_STATE_DIR. Injectable for tests. */
  stateRoot?: string;
  readdir?: (dir: string) => string[];
  readFile?: (path: string) => string;
}

export function listOpencodeSessions(deps: OpencodeSessionListDeps = {}): AgentSession[] {
  const stateRoot = deps.stateRoot ?? SQUADRANT_STATE_DIR;
  const readdir = deps.readdir ?? ((d: string) => readdirSync(d));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let projects: string[];
  try {
    projects = readdir(stateRoot);
  } catch {
    return []; // no state dir yet — nothing recorded
  }

  const out: AgentSession[] = [];
  for (const project of projects) {
    let rec: CaptainRecord;
    try {
      rec = JSON.parse(readFile(join(stateRoot, project, "captain.json"))) as CaptainRecord;
    } catch {
      continue; // absent or malformed both mean "no recorded captain"
    }
    if (!rec || rec.agent !== "opencode") continue;

    out.push({
      // A cold-started captain has no session until its first turn (#789);
      // synthesize a stable id so the row still names the project.
      id: rec.sessionId ?? `captain:${project}`,
      ...(rec.directory ? { cwd: rec.directory } : {}),
      // The record does not self-report status; it is the persisted address.
      status: "recorded",
      ...(rec.port != null ? { address: `http://127.0.0.1:${rec.port}` } : {}),
      project,
    });
  }
  return out;
}
