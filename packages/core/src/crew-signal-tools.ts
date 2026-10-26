// Tool definitions + handler for the `squadrant mcp` crew-signal tools (#1029). Agent-agnostic and SDK-free:
// the CLI registers these with the MCP SDK; tests drive `callCrewSignalTool` against a fake daemon `call`.
import { performCrewSignal, type CrewSignalState } from "./crew-signal.js";

export interface CrewSignalTool {
  name: string;
  state: CrewSignalState;
  description: string;
  /** Field name -> description. All fields are optional strings; task id/project default to the crew env. */
  fields: Record<string, string>;
}

const IDS = {
  task_id: "Explicit task id. Omit under a crew spawn: it is read from SQUADRANT_CREW_TASK_ID.",
  project: "Explicit project. Omit under a crew spawn: it is read from SQUADRANT_CREW_PROJECT.",
};

export const CREW_SIGNAL_TOOLS: CrewSignalTool[] = [
  {
    name: "crew_signal_done",
    state: "done",
    description:
      "Declare this crew task done, after your own settle-check (work committed, git status clean). Same as `squadrant crew signal done`. Errors if the task is already terminal.",
    fields: { message: "One-line summary for the captain. Append `Rules: <id>, <id>` if you applied knowledge-base rules.", ...IDS },
  },
  {
    name: "crew_signal_blocked",
    state: "blocked",
    description: "Tell the captain you are blocked and need a decision, then wait. Same as `squadrant crew signal blocked`.",
    fields: { question: "The question for the captain.", ...IDS },
  },
  {
    name: "crew_signal_failed",
    state: "failed",
    description: "Declare this crew task failed after an unrecoverable error. Same as `squadrant crew signal failed`.",
    fields: { error: "Why it failed.", ...IDS },
  },
  {
    name: "crew_signal_review",
    state: "review",
    description:
      "Checkpoint for captain review: work is committed on the crew branch and awaits a diff review before push + PR. Not terminal. Same as `squadrant crew signal review`.",
    fields: { message: "Review summary.", ...IDS },
  },
];

export interface CrewSignalToolResult {
  text: string;
  isError: boolean;
}

export async function callCrewSignalTool(
  name: string,
  args: Record<string, unknown>,
  deps: { call: (req: unknown) => Promise<unknown> },
): Promise<CrewSignalToolResult> {
  const tool = CREW_SIGNAL_TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `unknown tool '${name}'`, isError: true };
  const str = (k: string): string | undefined => (typeof args[k] === "string" && args[k] !== "" ? (args[k] as string) : undefined);
  const o = {
    ...(str("message") !== undefined ? { message: str("message")! } : {}),
    ...(str("question") !== undefined ? { question: str("question")! } : {}),
    ...(str("error") !== undefined ? { error: str("error")! } : {}),
    ...(str("task_id") !== undefined ? { taskId: str("task_id")! } : {}),
    ...(str("project") !== undefined ? { project: str("project")! } : {}),
  };
  try {
    return { text: await performCrewSignal(tool.state, o, deps), isError: false };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}

/**
 * The MCP `tools/list` payload. Each tool carries `_meta: { "anthropic/alwaysLoad": true }` so Claude Code
 * (>= 2.1.285) loads it upfront instead of deferring it behind ToolSearch; other MCP clients ignore `_meta`.
 */
export function crewSignalToolList() {
  return CREW_SIGNAL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(Object.entries(t.fields).map(([k, description]) => [k, { type: "string", description }])),
    },
    _meta: { "anthropic/alwaysLoad": true },
  }));
}
