// Captain-side tools of `squadrant mcp` (#1029). Each tool calls the same function its CLI command runs; this file is
// only the tool table, the argument plumbing and the role filter. Tools are listed only to a captain session
// (SQUADRANT_ROLE=captain, no crew id): crews see `crew_signal_*` alone and every other session sees nothing new.
// Deliberately absent (operator in the loop): crew approve/merge, crew answer, crew close --force, config/profile edits.
import { stripVTControlCharacters } from "node:util";
import { loadConfig, stateRoot } from "@squadrant/shared";
import { resolveCurrentProject, readUndelivered, crewSignalToolList, callCrewSignalTool, type CrewSignalToolResult } from "@squadrant/core";
import {
  buildCrewSpawnInput, runCrewSpawn, crewSendHint, runCrewSend, crewListLines, runCrewRead, readCrewMsg, runCrewClose,
} from "../commands/crew.js";
import { renderCrewTasks } from "../commands/crew-control.js";
import { runThreadOpen, runThreadPark, runThreadResume, threadListLines, formatOpened } from "../commands/thread.js";
import { runSideSpawn, runSideSend } from "../commands/side.js";
import { runPing, formatPingResult } from "../commands/ping.js";
import { runDispatch, formatDispatchResult } from "../commands/dispatch.js";
import { runCaptainCompact, compactQueuedLine } from "../commands/captain.js";
import { projectStatusRows } from "../commands/status.js";
import { queryHealth } from "../commands/health-view.js";
import { runRulesSearch, renderSearch } from "../commands/rules.js";
import { tailLines } from "../commands/crew-output.js";

export type McpRole = "crew" | "captain" | "other";

/** Crew wins over captain; anything unrecognised is "other" and gets no captain tools. */
export function mcpRole(env: NodeJS.ProcessEnv = process.env): McpRole {
  if (env.SQUADRANT_CREW_TASK_ID) return "crew";
  return env.SQUADRANT_ROLE === "captain" ? "captain" : "other";
}

/** The real functions behind the tools; tests pass fakes. */
export const realDeps = {
  buildCrewSpawnInput, runCrewSpawn, crewSendHint, runCrewSend, crewListLines, renderCrewTasks, runCrewRead, readCrewMsg, runCrewClose,
  runThreadOpen, runThreadPark, runThreadResume, threadListLines,
  runSideSpawn, runSideSend, runPing, runDispatch, runCaptainCompact,
  runRulesSearch, readUndelivered,
  /** The session's own project (from cwd), or null. */
  currentProject: (): string | null => resolveCurrentProject(loadConfig()),
  /** One row per registered project. */
  statusRows: async (): Promise<string[]> => projectStatusRows(loadConfig(), await queryHealth()),
};
export type CaptainDeps = typeof realDeps;

type Field = { type: "string" | "number" | "boolean" | "array"; description: string };
type Args = Record<string, unknown>;

interface CaptainTool {
  name: string;
  description: string;
  fields: Record<string, Field>;
  required?: string[];
  /** default: the `project` arg or the session's own project; required: the arg is the target and must be given; none: no project. */
  project: "default" | "required" | "none";
  run(a: Args, project: string, deps: CaptainDeps): Promise<string>;
}

const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : undefined);
const num = (a: Args, k: string): number | undefined => (typeof a[k] === "number" ? (a[k] as number) : undefined);
const bool = (a: Args, k: string): boolean => a[k] === true;
const need = (a: Args, k: string): string => {
  const v = str(a, k);
  if (v === undefined) throw new Error(`missing required argument '${k}'`);
  return v;
};

const PROJECT: Field = { type: "string", description: "Project name. Omit for the session's own project." };
const TARGET: Field = { type: "string", description: "Target project name (must be registered)." };
const NAME = (what: string): Field => ({ type: "string", description: `${what} name, e.g. crew-1.` });

export function createCaptainTools(): CaptainTool[] {
  return [
    {
      name: "crew_spawn", project: "default", required: ["task"],
      description: "Spawn an interactive crew session as a tab next to the captain. Same as `squadrant crew spawn`.",
      fields: {
        project: PROJECT, task: { type: "string", description: "Initial task prompt for the crew." }, name: { type: "string", description: "Crew name (default: auto-generated)." },
        agent: { type: "string", description: "claude|codex|gemini|opencode (default claude)." }, model: { type: "string", description: "Model alias for this spawn, e.g. sonnet." },
        thinking: { type: "string", description: "Thinking level for this spawn." }, backend: { type: "string", description: "native|direct|proxy (claude only)." },
        shared: { type: "boolean", description: "Run in the root checkout instead of an isolated worktree." }, approval: { type: "boolean", description: "Gate risky tools so the captain approves them." },
      },
      async run(a, p, d) {
        const agent = str(a, "agent");
        const input = await d.buildCrewSpawnInput(p, need(a, "task"), {
          name: str(a, "name"), agent, model: str(a, "model"), thinking: str(a, "thinking"), backend: str(a, "backend"),
          shared: bool(a, "shared"), approval: bool(a, "approval"),
        }, agent !== undefined);
        const pane = await d.runCrewSpawn(input);
        return `✔ Crew '${pane.title}' spawned (${pane.surfaceId})`;
      },
    },
    {
      name: "crew_send", project: "default", required: ["name", "message"],
      description: "Send a follow-up message to an existing crew session. Same as `squadrant crew send` (no --force).",
      fields: { project: PROJECT, name: NAME("Crew"), message: { type: "string", description: "Message to send." } },
      async run(a, p, d) {
        const name = need(a, "name");
        const hint = await d.crewSendHint(p, name);
        const { reopened } = await d.runCrewSend(p, name, need(a, "message"));
        return [hint ? `⚠ ${hint}` : "", reopened ? "↻ Task was terminal — reopened to working" : "", `✔ Sent to ${p}:${name}`].filter(Boolean).join("\n");
      },
    },
    {
      name: "crew_list", project: "default",
      description: "List live crew sessions for a project. Same as `squadrant crew list`.",
      fields: { project: PROJECT },
      async run(_a, p, d) {
        const lines = await d.crewListLines(p);
        return lines.length ? lines.join("\n") : `No live crew sessions for ${p}.`;
      },
    },
    {
      name: "crew_tasks", project: "default",
      description: "List a project's control-plane tasks (state, context). Same as `squadrant crew tasks` without purge.",
      fields: { project: PROJECT, id: { type: "string", description: "Only tasks matching this id prefix." }, state: { type: "string", description: "Only tasks in this state." }, json: { type: "boolean", description: "Full JSON records." } },
      run: async (a, p, d) => d.renderCrewTasks(p, { id: str(a, "id"), state: str(a, "state"), json: bool(a, "json") }),
    },
    {
      name: "crew_read", project: "default", required: ["name"],
      description: "Read the current screen of a crew session (tail). Same as `squadrant crew read`.",
      fields: { project: PROJECT, name: NAME("Crew"), lines: { type: "number", description: "Trailing lines (default 40)." }, full: { type: "boolean", description: "The whole scrollback." } },
      async run(a, p, d) {
        const screen = await d.runCrewRead(p, need(a, "name"));
        return bool(a, "full") ? screen : tailLines(screen, num(a, "lines") ?? 40);
      },
    },
    {
      name: "crew_msg", project: "default", required: ["seq"],
      description: "Print one mailbox entry in full (a crew's whole reply or question). Same as `squadrant crew msg`.",
      fields: { project: PROJECT, seq: { type: "number", description: "Mailbox seq from the delivery header." } },
      async run(a, p, d) {
        const { agentNote, text } = await d.readCrewMsg(p, num(a, "seq") ?? NaN);
        return agentNote ? `${agentNote}\n${text}` : text;
      },
    },
    {
      name: "crew_close", project: "default", required: ["name"],
      description: "Shut down a crew session (closes its tab). Same as `squadrant crew close`; there is no force.",
      fields: { project: PROJECT, name: NAME("Crew") },
      async run(a, p, d) {
        await d.runCrewClose(p, need(a, "name"));
        return `✔ Closed ${p}:${a.name}`;
      },
    },
    {
      name: "thread_open", project: "default", required: ["topic"],
      description: "Fork the captain into a new tab for one discussion topic. Same as `squadrant thread open`.",
      fields: { project: PROJECT, topic: { type: "string", description: "Topic of the discussion." }, crews: { type: "array", description: "Related crew names." } },
      async run(a, p, d) {
        const crews = Array.isArray(a.crews) ? a.crews.filter((c): c is string => typeof c === "string") : [];
        const { thread, note } = await d.runThreadOpen(p, need(a, "topic"), crews);
        const o = formatOpened(p, thread, note);
        return o.note ? `${o.head}\n${o.note}` : o.head;
      },
    },
    {
      name: "thread_park", project: "default", required: ["id"],
      description: "Park a thread. Without `decision`: ask the thread to write its decision record. With it (the record as JSON text): deliver it to the captain and close the tab. Same as `squadrant thread park`.",
      fields: { project: PROJECT, id: { type: "string", description: "Thread id." }, decision: { type: "string", description: "Decision record JSON." } },
      run: async (a, p, d) => d.runThreadPark(p, need(a, "id"), str(a, "decision")),
    },
    {
      name: "thread_resume", project: "default", required: ["id"],
      description: "Reopen a parked thread. Same as `squadrant thread resume`.",
      fields: { project: PROJECT, id: { type: "string", description: "Thread id." } },
      async run(a, p, d) {
        const { thread, note } = await d.runThreadResume(p, need(a, "id"));
        const o = formatOpened(p, thread, note);
        return o.note ? `${o.head}\n${o.note}` : o.head;
      },
    },
    {
      name: "thread_list", project: "default",
      description: "List a project's threads. Same as `squadrant thread list`.",
      fields: { project: PROJECT, all: { type: "boolean", description: "Include closed threads." } },
      async run(a, p, d) {
        const lines = d.threadListLines(p, bool(a, "all"));
        return lines.length ? lines.join("\n") : `No threads for ${p}.`;
      },
    },
    {
      name: "side_spawn", project: "default", required: ["topic", "role"],
      description: "Spawn a fresh-context side session (research or debug). Same as `squadrant side spawn`.",
      fields: {
        project: PROJECT, topic: { type: "string", description: "Topic or question." }, role: { type: "string", description: "research | debug." },
        name: { type: "string", description: "Session name (default: auto-generated)." }, agent: { type: "string", description: "claude|opencode (default claude)." },
      },
      async run(a, p, d) {
        const pane = await d.runSideSpawn({ project: p, topic: need(a, "topic"), role: need(a, "role"), name: str(a, "name"), direction: "tab", agent: str(a, "agent") ?? "claude" });
        return `✔ Side session '${pane.title}' spawned (${pane.surfaceId})`;
      },
    },
    {
      name: "side_send", project: "default", required: ["name", "message"],
      description: "Send a follow-up message to a side session. Same as `squadrant side send`.",
      fields: { project: PROJECT, name: NAME("Side session"), message: { type: "string", description: "Message to send." } },
      async run(a, p, d) {
        await d.runSideSend(p, need(a, "name"), need(a, "message"));
        return `✔ Sent to ${p}:${a.name}`;
      },
    },
    {
      name: "ping", project: "required", required: ["project", "message"],
      description: "Fire-and-forget message into another project's captain. Same as `squadrant ping`.",
      fields: { project: TARGET, message: { type: "string", description: "Message to deliver." } },
      async run(a, p, d) {
        return formatPingResult(p, await d.runPing(p, need(a, "message")));
      },
    },
    {
      name: "dispatch", project: "required", required: ["project", "task"],
      description: "Dispatch a tracked task to another project; reports back on settle. Same as `squadrant dispatch`.",
      fields: {
        project: TARGET, task: { type: "string", description: "Task description." },
        provider: { type: "string", description: "claude|opencode|codex (default claude)." }, mode: { type: "string", description: "headless|interactive (default headless)." },
      },
      async run(a, p, d) {
        const result = await d.runDispatch(p, need(a, "task"), { provider: (str(a, "provider") ?? "claude") as never, mode: (str(a, "mode") ?? "headless") as never });
        return formatDispatchResult(p, result).join("\n");
      },
    },
    {
      name: "captain_compact", project: "default",
      description: "Queue a /compact for the project's Claude captain; it runs once the captain's turn ends. Same as `squadrant captain compact`.",
      fields: { project: PROJECT, focus: { type: "string", description: "Focus text passed to /compact." } },
      async run(a, p, d) {
        await d.runCaptainCompact(p, str(a, "focus"));
        return compactQueuedLine(p);
      },
    },
    {
      name: "status", project: "none",
      description: "Captain liveness for every registered project. Same as `squadrant status`.",
      fields: {},
      async run(_a, _p, d) {
        const rows = await d.statusRows();
        return rows.length ? rows.join("\n") : "No projects registered.";
      },
    },
    {
      name: "rules_search", project: "default", required: ["query"],
      description: "Search the project's knowledge-base rules (read-only). Same as `squadrant rules search --brief`.",
      fields: { project: PROJECT, query: { type: "string", description: "Keywords." }, limit: { type: "number", description: "Max results (default 5)." } },
      async run(a, p, d) {
        const opts = { project: p, brief: true, ...(num(a, "limit") !== undefined ? { limit: num(a, "limit")! } : {}) };
        return renderSearch(d.runRulesSearch(need(a, "query"), opts), opts).join("\n");
      },
    },
    {
      name: "check_inbox", project: "default",
      description: "The captain's undelivered mailbox entries (crew replies, blockers, pings) — a pull for when nothing was pushed. Read one in full with crew_msg.",
      fields: { project: PROJECT },
      async run(_a, p, d) {
        const entries = await d.readUndelivered(stateRoot(), p);
        if (entries.length === 0) return `Inbox empty for ${p}.`;
        const first = (m: string | null | undefined) => (m ?? "").split("\n").find((l) => l.trim()) ?? "";
        const shown = entries.slice(-20).map((e) => `seq ${e.seq} · ${e.kind}${e.name ? ` · ${e.name}` : ""} — ${first(e.message).slice(0, 160)}`);
        return [`${entries.length} undelivered for ${p}:`, ...shown, "Read one in full with crew_msg <seq>."].join("\n");
      },
    },
  ];
}

const CAPTAIN_TOOLS = createCaptainTools();

/** The `tools/list` payload for this session's role. Captain tools all carry alwaysLoad; the crew and "other" lists are the existing crew-signal list. */
export function mcpToolList(env: NodeJS.ProcessEnv = process.env) {
  if (mcpRole(env) !== "captain") return crewSignalToolList(env);
  return CAPTAIN_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(Object.entries(t.fields).map(([k, f]) => [k, { type: f.type, description: f.description, ...(f.type === "array" ? { items: { type: "string" } } : {}) }])),
      ...(t.required ? { required: t.required } : {}),
    },
    _meta: { "anthropic/alwaysLoad": true },
  }));
}

/** Route a call: a captain session reaches only the captain tools, any other role only the crew-signal tools. */
export async function callMcpTool(
  name: string,
  args: Args,
  signalDeps: { call: (req: unknown) => Promise<unknown> },
  env: NodeJS.ProcessEnv = process.env,
  deps: CaptainDeps = realDeps,
): Promise<CrewSignalToolResult> {
  if (mcpRole(env) !== "captain") return callCrewSignalTool(name, args, signalDeps);
  const tool = CAPTAIN_TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `unknown tool '${name}'`, isError: true };
  try {
    let project = "";
    if (tool.project !== "none") {
      const given = str(args, "project");
      const resolved = given ?? (tool.project === "default" ? deps.currentProject() : null);
      if (!resolved) throw new Error(tool.project === "required" ? "missing required argument 'project'" : "could not determine the project from the session's directory — pass 'project'");
      project = resolved;
    }
    return { text: stripVTControlCharacters(await tool.run(args, project, deps)), isError: false };
  } catch (e) {
    return { text: stripVTControlCharacters((e as Error).message), isError: true };
  }
}
