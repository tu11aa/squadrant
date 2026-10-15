// packages/core/src/knowledge/profile-bridge.ts — native Claude memory → profile proposals (#982 S1, spec §6).
// One-way and read-only on the native side: squadrant never writes ~/.claude/projects/**.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHome, userKbDir, type SquadrantConfig } from "@squadrant/shared";
import { loadProfile } from "./profile.js";

/** `SQUADRANT_NATIVE_MEMORY_ROOT` overrides ~/.claude/projects (tests). */
export const nativeMemoryRoot = (env: NodeJS.ProcessEnv = process.env) =>
  env.SQUADRANT_NATIVE_MEMORY_ROOT || path.join(os.homedir(), ".claude", "projects");

/** How Claude Code names a project dir (same as deriveTranscriptPath). Compared by equality, never decoded. */
export const encodeClaudeDir = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

const MEMORY_REF_RE = /^memory:([^/]+)\/([^#]+)#([0-9a-f]{12})$/;

/** Native memory files that back an active trait and still exist: the operator may delete them; squadrant never does. */
export function coveredNativeFiles(cfg: SquadrantConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = nativeMemoryRoot(env);
  const out = new Set<string>();
  for (const t of loadProfile(userKbDir(cfg, env)).active) {
    for (const s of t.sources) {
      const m = MEMORY_REF_RE.exec(s);
      const file = m && path.join(root, m[1], "memory", m[2]);
      if (file && fs.existsSync(file)) out.add(file);
    }
  }
  return [...out].sort();
}

/** The allowlisted Claude project dirs (P14): each registered project path, plus $HOME. */
export function allowlistedDirs(cfg: SquadrantConfig, home = os.homedir()): string[] {
  const paths = [...Object.values(cfg.projects ?? {}).map((pc) => path.resolve(resolveHome(pc.path))), home];
  return [...new Set(paths.map(encodeClaudeDir))];
}
