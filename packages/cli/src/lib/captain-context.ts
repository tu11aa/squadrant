// captain-context.ts — #1015: which Claude transcript is the project's captain,
// and how big is its context. Ground truth from the session registry (#651,
// written by the captain's SessionStart hook), never an mtime guess.
import fs from "node:fs";
import { workspacePath, loadConfig } from "@squadrant/shared";
import { readClaudeContext } from "@squadrant/core";
import type { ContextMeter } from "@squadrant/core";
import { readCaptainSessionRegistry } from "./captain-session-registry.js";
import type { CaptainSessionRecord } from "./handoff-facts.js";

/** Newest registered claude captain session for `project` whose transcript exists, else null. */
export function captainSession(project: string): CaptainSessionRecord | null {
  try {
    const proj = loadConfig().projects[project];
    const vaults = [workspacePath(project), ...(proj?.spokeVault ? [proj.spokeVault] : [])];
    const newest = vaults
      .flatMap((v) => readCaptainSessionRegistry(v))
      .filter((r) => r.agent === "claude" && r.transcriptPath && fs.existsSync(r.transcriptPath))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    return newest ?? null;
  } catch {
    return null;
  }
}

export function captainTranscriptPath(project: string): string | null {
  return captainSession(project)?.transcriptPath ?? null;
}

export function captainContext(project: string): ContextMeter {
  const p = captainTranscriptPath(project);
  return p ? readClaudeContext(p) : "unknown";
}
