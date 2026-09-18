// packages/cli/src/commands/sessions.ts
//
// #669: `squadrant sessions` — list live agent sessions, read-only.
//
// Registry-backed and agent-agnostic: each AgentDriver that can enumerate its
// sessions implements `listSessions`; agents that cannot simply omit it and are
// reported unsupported. No daemon, no delivery, no state mutation.
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveHome } from "@squadrant/shared";
import {
  createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver,
  type AgentDriver, type AgentSession,
} from "@squadrant/agents";

/** A session plus the agent it belongs to (the list is a union across drivers). */
export interface SessionRow extends AgentSession {
  agent: string;
}

export interface SessionFilter {
  agent?: string;
  project?: string;
  liveOnly?: boolean;
  /** Project name → absolute path, for cwd-based project matching. */
  projects?: Record<string, string>;
}

export const KNOWN_AGENTS = ["claude", "opencode", "codex", "gemini"] as const;

function normalized(p: string): string {
  return p.replace(/\/+$/, "");
}

export function filterSessions(rows: SessionRow[], f: SessionFilter): SessionRow[] {
  return rows.filter((r) => {
    if (f.agent && r.agent !== f.agent) return false;
    if (f.liveOnly && r.status === "stale") return false;
    if (f.project) {
      const path = f.projects?.[f.project];
      const byRecord = r.project === f.project;
      const byCwd =
        !!path && !!r.cwd && (r.cwd === normalized(path) || r.cwd.startsWith(normalized(path) + "/"));
      if (!byRecord && !byCwd) return false;
    }
    return true;
  });
}

const dash = (v: string | number | undefined): string => (v === undefined || v === "" ? "-" : String(v));

export function formatSessionTable(rows: SessionRow[]): string {
  if (rows.length === 0) return "No live agent sessions found.";
  const header = ["AGENT", "ID", "PID", "STATUS", "ADDRESS", "CWD"];
  const body = rows.map((r) => [
    r.agent,
    r.id,
    dash(r.pid),
    r.status,
    dash(r.address),
    dash(r.cwd),
  ]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

/** Enumerate every driver that implements introspection. Never throws. */
export async function collectSessions(
  drivers: Record<string, AgentDriver>,
): Promise<{ rows: SessionRow[]; unsupported: string[] }> {
  const rows: SessionRow[] = [];
  const unsupported: string[] = [];
  for (const [agent, driver] of Object.entries(drivers)) {
    if (typeof driver.listSessions !== "function") {
      unsupported.push(agent);
      continue;
    }
    try {
      for (const s of await driver.listSessions()) rows.push({ agent, ...s });
    } catch {
      // A single driver's read failure must not blind the command to the rest.
      unsupported.push(agent);
    }
  }
  return { rows, unsupported };
}

export const sessionsCommand = new Command("sessions")
  .description("List live agent sessions squadrant can introspect (read-only; claude + opencode)")
  .option("--json", "emit machine-readable JSON")
  .option("--agent <name>", `filter to one agent (${KNOWN_AGENTS.join("|")})`)
  .option("--project <name>", "filter to one registered project")
  .option("--live-only", "drop sessions whose process is dead (status: stale)")
  .action(async (opts: { json?: boolean; agent?: string; project?: string; liveOnly?: boolean }) => {
    if (opts.agent && !(KNOWN_AGENTS as readonly string[]).includes(opts.agent)) {
      console.error(chalk.red(`\n  ✘ Unknown agent '${opts.agent}'. Known agents: ${KNOWN_AGENTS.join(", ")}\n`));
      process.exit(1);
    }

    const config = loadConfig();
    if (opts.project && !(opts.project in config.projects)) {
      const known = Object.keys(config.projects).sort().join(", ") || "(none registered)";
      console.error(chalk.red(`\n  ✘ Unknown project '${opts.project}'. Known projects: ${known}\n`));
      process.exit(1);
    }
    const projects = Object.fromEntries(
      Object.entries(config.projects).map(([n, p]) => [n, resolveHome(p.path)]),
    );

    const drivers: Record<string, AgentDriver> = {
      claude: createClaudeDriver(),
      opencode: createOpencodeDriver(),
      codex: createCodexDriver(),
      gemini: createGeminiDriver(),
    };

    const { rows, unsupported } = await collectSessions(drivers);

    // An explicit --agent for an unsupported agent is a hard error — silence
    // would read as "no sessions" rather than "cannot introspect".
    if (opts.agent && unsupported.includes(opts.agent)) {
      console.error(chalk.red(`\n  ✘ Agent '${opts.agent}' does not support session introspection.\n`));
      process.exit(1);
    }

    const filtered = filterSessions(rows, {
      agent: opts.agent,
      project: opts.project,
      liveOnly: opts.liveOnly,
      projects,
    });

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2));
    } else {
      console.log(formatSessionTable(filtered));
      if (!opts.agent && unsupported.length > 0) {
        console.error(chalk.dim(`(unsupported for session introspection: ${unsupported.join(", ")})`));
      }
    }
  });
