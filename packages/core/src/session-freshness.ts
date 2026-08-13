// Session freshness logic — daily + templateHash rotation.
// Extracted from packages/cli/src/commands/launch.ts so it can be
// unit-tested without spawning real processes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readConfigFileSync, writeConfigFileSync } from "@squadrant/shared";

export interface SessionRecord {
  lastLaunched: string; // YYYY-MM-DD
  templateHash: string;
}

export interface SessionsFile {
  workspaces: Record<string, SessionRecord>;
}

export function loadSessions(sessionsPath: string): SessionsFile {
  try {
    return JSON.parse(readConfigFileSync(sessionsPath)) as SessionsFile;
  } catch {
    return { workspaces: {} };
  }
}

export function saveSessions(sessionsPath: string, sessions: SessionsFile): void {
  writeConfigFileSync(sessionsPath, JSON.stringify(sessions, null, 2) + "\n");
}

export function computeTemplateHash(role: string, templatesDir: string): string {
  const hash = crypto.createHash("sha256");

  const roleFile = path.join(templatesDir, `${role}.claude.md`);
  const legacyRoleFile = path.join(templatesDir, `${role}.CLAUDE.md`);
  if (fs.existsSync(roleFile)) {
    hash.update(fs.readFileSync(roleFile, "utf-8"));
  } else if (fs.existsSync(legacyRoleFile)) {
    hash.update(fs.readFileSync(legacyRoleFile, "utf-8"));
  }

  const pluginSkillsDir = path.join(templatesDir, "..", "plugin", "skills");
  if (fs.existsSync(pluginSkillsDir)) {
    for (const skill of fs.readdirSync(pluginSkillsDir).sort()) {
      const skillFile = path.join(pluginSkillsDir, skill, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        hash.update(fs.readFileSync(skillFile, "utf-8"));
      }
    }
  }

  return hash.digest("hex").slice(0, 16);
}

export function shouldStartFresh(
  workspaceName: string,
  role: string,
  opts: { sessionsPath: string; templatesDir: string },
): { fresh: boolean; reason?: string } {
  const sessions = loadSessions(opts.sessionsPath);
  const record = sessions.workspaces[workspaceName];
  const today = new Date().toISOString().slice(0, 10);
  const currentHash = computeTemplateHash(role, opts.templatesDir);

  if (!record) {
    return { fresh: true, reason: "first launch" };
  }

  if (record.lastLaunched !== today) {
    return { fresh: true, reason: "new day — starting fresh session" };
  }

  if (record.templateHash !== currentHash) {
    return { fresh: true, reason: "template instructions updated" };
  }

  return { fresh: false };
}

export function recordSession(
  workspaceName: string,
  role: string,
  opts: { sessionsPath: string; templatesDir: string },
): void {
  const sessions = loadSessions(opts.sessionsPath);
  sessions.workspaces[workspaceName] = {
    lastLaunched: new Date().toISOString().slice(0, 10),
    templateHash: computeTemplateHash(role, opts.templatesDir),
  };
  saveSessions(opts.sessionsPath, sessions);
}
