// P6 (#828): squadrant consumes the standalone @squadrant-ai/auto-gate package
// through its §3 bridge. These tests pin the two load-bearing behaviours:
//   B1 — the gate is a NO-OP unless defaults.gate.mode === "on";
//   B3 — an `ask` maps to exactly one #560 task.blocked; allow/deny map to none.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlEvent, SquadrantConfig } from "@squadrant/shared";
import { getDefaultConfig } from "@squadrant/shared";
import type { GateOutcome } from "@squadrant-ai/auto-gate";
import { createSquadrantAutoGate } from "../auto-gate.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SquadrantConfig["defaults"]> = {}): SquadrantConfig {
  const base = getDefaultConfig();
  return { ...base, defaults: { ...base.defaults, ...overrides } };
}

const CREW_ENV = {
  SQUADRANT_CREW_TASK_ID: "task-1",
  SQUADRANT_CREW_PROJECT: "proj",
} as NodeJS.ProcessEnv;

const HOOK_PAYLOAD = JSON.stringify({
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  permission_mode: "default",
  cwd: "/repo",
});

function harness(over: {
  gate?: SquadrantConfig["defaults"]["gate"];
  env?: NodeJS.ProcessEnv;
  decide?: (req: unknown) => Promise<GateOutcome>;
} = {}) {
  const blocked: Array<{ project: string; event: ControlEvent }> = [];
  const decide = vi.fn(
    over.decide ?? (async () => ({ decision: "allow", tier: 2, reason: "test" }) as GateOutcome),
  );
  const gate = createSquadrantAutoGate({
    config: makeConfig(over.gate !== undefined ? { gate: over.gate } : {}),
    env: over.env ?? CREW_ENV,
    sendBlocked: async (project, event) => {
      blocked.push({ project, event });
    },
    decide,
    log: () => {},
  });
  return { gate, decide, blocked };
}

// ── B1: mode gate — only an explicit "on" runs the gate ────────────────────────

describe("createSquadrantAutoGate — B1 mode gate (spec §10/§12)", () => {
  it("absent defaults.gate → NO-OP (never decides, emits nothing)", async () => {
    const { gate, decide, blocked } = harness({ env: CREW_ENV });
    const out = await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(out).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
    expect(blocked).toHaveLength(0);
    expect(gate.config.mode).toBe("off");
  });

  it("mode 'auto' → NO-OP (projects to 'off'; never decides)", async () => {
    const { gate, decide, blocked } = harness({ gate: { mode: "auto" }, env: CREW_ENV });
    const out = await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(out).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
    expect(blocked).toHaveLength(0);
    expect(gate.config.mode).toBe("off");
  });

  it("mode 'off' → NO-OP (never decides)", async () => {
    const { gate, decide } = harness({ gate: { mode: "off" }, env: CREW_ENV });
    expect(await gate.decideClaudeHookPayload(HOOK_PAYLOAD)).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
  });

  it("mode 'on' → the gate decides (projected mode stays 'on')", async () => {
    const { gate, decide } = harness({ gate: { mode: "on" }, env: CREW_ENV });
    expect(gate.config.mode).toBe("on");
    const out = await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out as string).hookSpecificOutput.decision.behavior).toBe("allow");
  });

  it("mode 'on' → forwards the projected tools/deny subset", async () => {
    const { gate } = harness({
      gate: { mode: "on", tools: ["Bash"], deny: ["^curl\\b"] },
      env: CREW_ENV,
    });
    expect(gate.config.tools).toEqual(["Bash"]);
    expect(gate.config.deny).toEqual(["^curl\\b"]);
  });
});

// ── B3: ask → exactly one task.blocked; allow/deny → none ─────────────────────

describe("createSquadrantAutoGate — B3 blocked-signal → #560 task.blocked", () => {
  it("ask → exactly one task.blocked with the modal-path event shape", async () => {
    const { gate, blocked } = harness({
      gate: { mode: "on" },
      env: CREW_ENV,
      decide: async () => ({ decision: "ask", tier: 2, reason: "ambiguous" }),
    });
    const out = await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    // ask prints nothing to Claude (the normal dialog appears).
    expect(out).toBeUndefined();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.project).toBe("proj");
    expect(blocked[0]!.event).toEqual({
      type: "task.blocked",
      id: "task-1",
      reason: "ambiguous",
      question: "crew needs permission to run Bash",
    });
  });

  it("allow → no task.blocked", async () => {
    const { gate, blocked } = harness({
      gate: { mode: "on" },
      env: CREW_ENV,
      decide: async () => ({ decision: "allow", tier: 2, reason: "safe" }),
    });
    await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(blocked).toHaveLength(0);
  });

  it("deny → no task.blocked", async () => {
    const { gate, blocked } = harness({
      gate: { mode: "on" },
      env: CREW_ENV,
      decide: async () => ({ decision: "deny", tier: 1, reason: "destructive" }),
    });
    const out = await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(JSON.parse(out as string).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(blocked).toHaveLength(0);
  });

  it("an operator session (no crew task) never emits task.blocked on ask", async () => {
    const { gate, blocked } = harness({
      gate: { mode: "on" },
      env: { SQUADRANT_ROLE: "captain" },
      decide: async () => ({ decision: "ask", tier: 2, reason: "ambiguous" }),
    });
    await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(blocked).toHaveLength(0);
  });
});

// ── P6-C: the host's on-check honours the SQUADRANT_GATE env override ─────────
// Router-backed crews inject SQUADRANT_GATE=on with NO config gate block. The
// package's own projection maps an absent/auto config mode to "off", so the
// squadrant host must resolve the mode the U7 way (env → config → auto) and
// hand the package a projection whose mode is "on".

describe("createSquadrantAutoGate — env SQUADRANT_GATE override (P6-C)", () => {
  it("env 'on' with no config gate → decides (not a no-op)", async () => {
    const { gate, decide } = harness({ env: { ...CREW_ENV, SQUADRANT_GATE: "on" } });
    expect(gate.config.mode).toBe("on");
    const out = await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out as string).hookSpecificOutput.decision.behavior).toBe("allow");
  });

  it("env 'off' with config mode 'on' → NO-OP (env wins)", async () => {
    const { gate, decide } = harness({
      gate: { mode: "on" },
      env: { ...CREW_ENV, SQUADRANT_GATE: "off" },
    });
    expect(await gate.decideClaudeHookPayload(HOOK_PAYLOAD)).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
  });

  it("an invalid env value falls back to the config mode (never silently off)", async () => {
    const { gate, decide } = harness({
      gate: { mode: "on" },
      env: { ...CREW_ENV, SQUADRANT_GATE: "banana" },
    });
    expect(gate.config.mode).toBe("on");
    await gate.decideClaudeHookPayload(HOOK_PAYLOAD);
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

// ── B1: U7 transcript reader wired through ────────────────────────────────────
describe("createSquadrantAutoGate — transcript reader (U7 extractUserIntentFromTranscript)", () => {
  it("supplies the last human message from the transcript to the classifier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-intent-"));
    try {
      const transcript = join(dir, "t.jsonl");
      writeFileSync(
        transcript,
        [
          JSON.stringify({ type: "assistant", message: { role: "assistant", content: "working" } }),
          JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "add a login form" }] } }),
        ].join("\n"),
      );
      let seen: { toolName?: string; userIntent?: string | null } = {};
      const { gate } = harness({
        gate: { mode: "on" },
        env: CREW_ENV,
        decide: async (req) => {
          seen = req as typeof seen;
          return { decision: "allow", tier: 2, reason: "safe" };
        },
      });
      await gate.decideClaudeHookPayload(
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, transcript_path: transcript }),
      );
      expect(seen.toolName).toBe("Bash");
      expect(seen.userIntent).toBe("add a login form");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
