import { describe, it, expect } from "vitest";
import { decideSubagentCrewSignal } from "../interactive/claude.js";

const SUB = { agent_id: "aaba977f7f7ed2495", agent_type: "general-purpose" };

describe("decideSubagentCrewSignal (#1068)", () => {
  it("denies a crew_signal MCP tool call from a subagent", () => {
    for (const t of ["done", "review", "blocked", "failed"]) {
      const r = decideSubagentCrewSignal({ ...SUB, tool_name: `mcp__squadrant__crew_signal_${t}`, tool_input: { message: "x" } });
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/return your result to the parent/);
    }
  });

  it("denies `squadrant crew signal` via Bash from a subagent", () => {
    const r = decideSubagentCrewSignal({ ...SUB, tool_name: "Bash", tool_input: { command: 'squadrant crew signal done --message "ok"' } });
    expect(r.decision).toBe("deny");
  });

  it("allows the same calls from the main session (no agent_id)", () => {
    expect(decideSubagentCrewSignal({ tool_name: "mcp__squadrant__crew_signal_review", tool_input: {} }).decision).toBe("allow");
    expect(decideSubagentCrewSignal({ tool_name: "Bash", tool_input: { command: "squadrant crew signal done" } }).decision).toBe("allow");
  });

  it("allows non-signal tools from a subagent", () => {
    expect(decideSubagentCrewSignal({ ...SUB, tool_name: "Bash", tool_input: { command: "squadrant crew status p t" } }).decision).toBe("allow");
    expect(decideSubagentCrewSignal({ ...SUB, tool_name: "Read", tool_input: { file_path: "/x" } }).decision).toBe("allow");
    expect(decideSubagentCrewSignal({ ...SUB, tool_name: "mcp__squadrant__other", tool_input: {} }).decision).toBe("allow");
  });

  it("fails open on malformed payloads", () => {
    expect(decideSubagentCrewSignal(undefined).decision).toBe("allow");
    expect(decideSubagentCrewSignal({ agent_id: "", tool_name: "mcp__squadrant__crew_signal_done" }).decision).toBe("allow");
  });
});
