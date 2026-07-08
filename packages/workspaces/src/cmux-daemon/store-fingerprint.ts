import { resolveHome } from "@squadrant/shared";
import type { RuntimeLivenessRecord, Role } from "@squadrant/shared";

interface RawSession {
  sessionId?: string; pid?: number | null; cwd?: string; isRestorable?: boolean;
  launchCommand?: { arguments?: string[]; workingDirectory?: string };
}

/** template basename → role (captain.claude.md → captain, crew.claude.md → crew, …). */
function roleFromTemplate(args: string[] | undefined): Role | "unknown" {
  const i = args?.indexOf("--append-system-prompt-file") ?? -1;
  const tmpl = i >= 0 && args ? (args[i + 1] ?? "").split("/").pop() ?? "" : "";
  if (tmpl.startsWith("captain")) return "captain";
  if (tmpl.startsWith("crew")) return "crew";
  if (tmpl.startsWith("command")) return "command";
  return "unknown"; // side.research.* etc. — not a captain
}

function projectFromCwd(cwd: string, projects: Record<string, { path: string }>): string | undefined {
  for (const [name, p] of Object.entries(projects)) {
    const projPath = resolveHome(p.path);
    if (cwd === projPath || cwd.startsWith(`${projPath}/`)) return name;
  }
  return undefined;
}

/**
 * Parse one store file's content. Throws on invalid JSON — a corrupt/mid-write
 * file is a failed read, NOT a valid file with zero sessions; callers (see
 * `readLivenessSnapshot`) must be able to tell the two apart so a locked file
 * never false-reads as "no captains".
 */
export function parseStoreRecords(
  fileContent: string,
  projects: Record<string, { path: string }>,
): RuntimeLivenessRecord[] {
  let parsed: { sessions?: Record<string, RawSession> };
  try { parsed = JSON.parse(fileContent); }
  catch (e) { throw new Error(`parseStoreRecords: invalid JSON: ${(e as Error).message}`); }
  const out: RuntimeLivenessRecord[] = [];
  for (const s of Object.values(parsed.sessions ?? {})) {
    const cwd = s.cwd ?? s.launchCommand?.workingDirectory ?? "";
    const project = projectFromCwd(cwd, projects);
    if (!project || !s.sessionId) continue;
    out.push({
      role: roleFromTemplate(s.launchCommand?.arguments),
      project,
      pid: typeof s.pid === "number" ? s.pid : null,
      sessionId: s.sessionId,
      present: true,
      isRestorable: s.isRestorable,
    });
  }
  return out;
}

/**
 * Read+parse every given store file, tolerating individual bad files (locked
 * mid-write, corrupt) as long as at least one yields a good read. Only throws
 * when EVERY file failed — a locked/corrupt store must never look like "read
 * succeeded, zero captains present" (that would false-close every known
 * captain this tick). Genuinely zero files (none present) is a valid empty read.
 */
export function readLivenessSnapshot(
  files: string[],
  readFile: (filename: string) => string,
  projects: Record<string, { path: string }>,
): RuntimeLivenessRecord[] {
  const out: RuntimeLivenessRecord[] = [];
  let successes = 0;
  for (const f of files) {
    try {
      out.push(...parseStoreRecords(readFile(f), projects));
      successes++;
    } catch { /* this file unreadable/corrupt — other files may still be good */ }
  }
  if (files.length > 0 && successes === 0) {
    throw new Error(`readLivenessSnapshot: all ${files.length} store file(s) unreadable/corrupt this tick`);
  }
  return out;
}
