import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { resolveHome } from "../config.js";
import type { WorkspaceDriver } from "../types/workspaces.js";

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export function enumerateDays(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    out.push(iso(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export interface DailyLog {
  content: string;
  blockers: string[];
}

export async function readDailyLog(
  workspace: WorkspaceDriver,
  dateStr: string,
): Promise<DailyLog | null> {
  const relPath = `daily-logs/${dateStr}.md`;
  if (!(await workspace.exists(relPath))) return null;

  const raw = await workspace.read(relPath);
  const { content } = matter(raw);

  const blockers: string[] = [];
  const blockerMatch = content.match(/## Blocked\n([\s\S]*?)(?=\n##|$)/);
  if (blockerMatch) {
    const lines = blockerMatch[1].trim().split("\n");
    for (const line of lines) {
      const trimmed = line.replace(/^[-*]\s*/, "").trim();
      if (trimmed && trimmed !== "(none)" && trimmed !== "None") {
        blockers.push(trimmed);
      }
    }
  }
  return { content, blockers };
}

export function parseSection(content: string, section: string): string[] {
  const match = content.match(new RegExp(`## ${section}\\n([\\s\\S]*?)(?=\\n##|$)`));
  if (!match) return [];
  return match[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && l !== "(none)" && l !== "None");
}

export function getGitCommits(projectPath: string, dateStr: string): string[] {
  return getGitCommitsInRange(projectPath, `${dateStr} 00:00:00`, `${dateStr} 23:59:59`);
}

export function getGitCommitsInRange(projectPath: string, since: string, until?: string): string[] {
  const resolved = resolveHome(projectPath);
  if (!fs.existsSync(path.join(resolved, ".git"))) return [];

  const untilArg = until ? ` --until="${until}"` : "";
  try {
    const output = execSync(
      `git -C "${resolved}" log --since="${since}"${untilArg} --oneline --no-merges 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (!output) return [];
    return output.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getMergedPRsInRange(projectPath: string, since: string, until?: string): string[] {
  const resolved = resolveHome(projectPath);
  if (!fs.existsSync(path.join(resolved, ".git"))) return [];

  const untilArg = until ? ` --until="${until}"` : "";
  try {
    const output = execSync(
      `git -C "${resolved}" log --merges --since="${since}"${untilArg} --pretty=format:%s 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (!output) return [];
    return output.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
