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

export function parseStoreRecords(
  fileContent: string,
  projects: Record<string, { path: string }>,
): RuntimeLivenessRecord[] {
  let parsed: { sessions?: Record<string, RawSession> };
  try { parsed = JSON.parse(fileContent); } catch { return []; }
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
