// Tests for NativeHookSource — LifecycleSource C (primary, #333 Phase 1)
//
// All I/O deps are injected so tests run without touching disk or real processes.
import { describe, it, expect, vi } from "vitest";
import {
  NativeHookSource,
  installClaudeHooks,
  mapSubToLifecycle,
} from "../native-hook-source.js";
import type { ClaudeHooksInstallOpts, NativeHookSourceOpts } from "../native-hook-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TASK_ID = "task-abc-123";
const HOOK_CMD = "squadrant hooks";
const SETTINGS_PATH = "/fake/.claude/settings.json";

/** Build a LifecycleSourceDeps that captures reports. */
function makeDeps() {
  const reports: LifecycleSnapshot[] = [];
  const deps: LifecycleSourceDeps = {
    resolve: (hint) => (hint.taskId === TASK_ID ? { id: TASK_ID } : undefined),
    report: (snap) => reports.push(snap),
    log: vi.fn(),
  };
  return { deps, reports };
}

/** Build ClaudeHooksInstallOpts with injectable I/O. */
function makeInstallOpts(overrides: {
  existingSettings?: Record<string, unknown>;
  existingRaw?: string;
} = {}): { opts: ClaudeHooksInstallOpts; written: Array<{ path: string; content: string }> } {
  const written: Array<{ path: string; content: string }> = [];
  const opts: ClaudeHooksInstallOpts = {
    settingsPath: SETTINGS_PATH,
    hookCmd: HOOK_CMD,
    readFile: () => {
      if (overrides.existingRaw !== undefined) return overrides.existingRaw;
      if (overrides.existingSettings !== undefined) return JSON.stringify(overrides.existingSettings);
      return undefined;
    },
    writeFile: (path, content) => written.push({ path, content }),
    log: vi.fn(),
  };
  return { opts, written };
}

/** Build a NativeHookSource with injectable install opts. */
function makeSource(installOverrides: Parameters<typeof makeInstallOpts>[0] = {}): {
  src: NativeHookSource;
  installOpts: ClaudeHooksInstallOpts;
  written: Array<{ path: string; content: string }>;
} {
  const { opts, written } = makeInstallOpts(installOverrides);
  const src = new NativeHookSource({ hookInstall: opts });
  return { src, installOpts: opts, written };
}

// ── installClaudeHooks ────────────────────────────────────────────────────────

describe("installClaudeHooks — basic installation", () => {
  it("installs hooks for all 7 lifecycle-relevant subs across 6 event keys", () => {
    const { opts, written } = makeInstallOpts();
    installClaudeHooks(opts);

    expect(written).toHaveLength(1);
    const result = JSON.parse(written[0].content);
    // 6 unique event keys (PreToolUse appears twice: catch-all + AskUserQuestion matcher)
    for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification", "SessionEnd"]) {
      expect(result.hooks[ev]).toBeDefined();
      expect(Array.isArray(result.hooks[ev])).toBe(true);
      expect(result.hooks[ev].length).toBeGreaterThan(0);
    }
    // AskUserQuestion is a TOOL not an event — must never be a top-level hook key
    expect(result.hooks["AskUserQuestion"]).toBeUndefined();
    // PreToolUse carries both the catch-all and the AskUserQuestion-specific entry
    expect(result.hooks.PreToolUse).toHaveLength(2);
  });

  it("each installed hook entry uses the correct sub-command alias", () => {
    const { opts, written } = makeInstallOpts();
    installClaudeHooks(opts);

    const result = JSON.parse(written[0].content);
    // Single-entry events: first (and only) entry carries the sub-command
    const singleEntryExpectations: Array<[string, string]> = [
      ["SessionStart", "session-start"],
      ["UserPromptSubmit", "prompt-submit"],
      ["Stop", "stop"],
      ["Notification", "notification"],
      ["SessionEnd", "session-end"],
    ];
    for (const [ev, sub] of singleEntryExpectations) {
      const entry = result.hooks[ev][0];
      expect(entry.hooks[0].command).toBe(`${HOOK_CMD} claude ${sub}`);
    }
    // PreToolUse: catch-all (matcher "") and AskUserQuestion-specific (matcher "AskUserQuestion")
    const hasCmd = (entries: unknown[], cmd: string): boolean =>
      entries.some(
        (e) =>
          Array.isArray((e as Record<string, unknown>).hooks) &&
          ((e as Record<string, unknown>).hooks as unknown[]).some(
            (h) => (h as Record<string, unknown>).command === cmd,
          ),
      );
    expect(hasCmd(result.hooks.PreToolUse, `${HOOK_CMD} claude pre-tool-use`)).toBe(true);
    expect(hasCmd(result.hooks.PreToolUse, `${HOOK_CMD} claude ask-question`)).toBe(true);
    // ask-question entry must carry the AskUserQuestion tool matcher
    const askEntry = (result.hooks.PreToolUse as unknown[]).find(
      (e) => hasCmd([e], `${HOOK_CMD} claude ask-question`),
    ) as Record<string, unknown> | undefined;
    expect(askEntry?.matcher).toBe("AskUserQuestion");
  });

  it("returns the settings file path", () => {
    const { opts } = makeInstallOpts();
    const returned = installClaudeHooks(opts);
    expect(returned).toBe(SETTINGS_PATH);
  });

  it("writes when settings file is absent (creates fresh)", () => {
    const { opts, written } = makeInstallOpts({ existingSettings: undefined });
    installClaudeHooks(opts);
    expect(written).toHaveLength(1);
  });
});

describe("installClaudeHooks — idempotency (D4: re-run-safe)", () => {
  it("does not write the file on a second call when hooks are already present", () => {
    const { opts, written } = makeInstallOpts();
    installClaudeHooks(opts);
    const contentAfterFirst = written[0].content;

    // Second call: feed the first-call output back as existing content.
    const { opts: opts2, written: written2 } = makeInstallOpts({ existingRaw: contentAfterFirst });
    installClaudeHooks(opts2);

    expect(written2).toHaveLength(0);
  });

  it("does not duplicate hook entries on repeated calls", () => {
    const { opts, written } = makeInstallOpts();
    installClaudeHooks(opts);
    const afterFirst = written[0].content;

    const { opts: opts2, written: written2 } = makeInstallOpts({ existingRaw: afterFirst });
    installClaudeHooks(opts2);

    // No second write means no change.
    expect(written2).toHaveLength(0);
    // And the first result has exactly one entry per event (no duplication).
    const result = JSON.parse(afterFirst);
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.SessionEnd).toHaveLength(1);
  });
});

describe("installClaudeHooks — non-clobbering (D4: preserves existing hooks)", () => {
  it("preserves existing non-squadrant hooks in the same event array", () => {
    const userHook = { matcher: "*", hooks: [{ type: "command", command: "my-tool hook-stop" }] };
    const { opts, written } = makeInstallOpts({
      existingSettings: { hooks: { Stop: [userHook] } },
    });
    installClaudeHooks(opts);

    const result = JSON.parse(written[0].content);
    const stopEntries = result.hooks.Stop;
    expect(stopEntries.some((e: unknown) =>
      (e as Record<string, unknown>).hooks &&
      ((e as Record<string, unknown>).hooks as unknown[]).some(
        (h: unknown) => (h as Record<string, unknown>).command === "my-tool hook-stop",
      ),
    )).toBe(true);
  });

  it("preserves unrelated top-level settings fields (model, permissions, etc.)", () => {
    const { opts, written } = makeInstallOpts({
      existingSettings: { model: "claude-sonnet-4-6", permissions: { allow: ["Bash(git:*)"] } },
    });
    installClaudeHooks(opts);

    const result = JSON.parse(written[0].content);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.permissions).toEqual({ allow: ["Bash(git:*)"] });
  });

  it("preserves hooks from other tools under the same event (namespacing)", () => {
    const cmuxHook = { matcher: "", hooks: [{ type: "command", command: "cmux hooks claude stop" }] };
    const { opts, written } = makeInstallOpts({
      existingSettings: { hooks: { Stop: [cmuxHook] } },
    });
    installClaudeHooks(opts);

    const result = JSON.parse(written[0].content);
    const stopEntries = result.hooks.Stop;
    // cmux hook preserved
    expect(stopEntries.some((e: unknown) =>
      (e as Record<string, unknown>).hooks &&
      ((e as Record<string, unknown>).hooks as unknown[]).some(
        (h: unknown) => (h as Record<string, unknown>).command === "cmux hooks claude stop",
      ),
    )).toBe(true);
    // squadrant hook also added
    expect(stopEntries.some((e: unknown) =>
      (e as Record<string, unknown>).hooks &&
      ((e as Record<string, unknown>).hooks as unknown[]).some(
        (h: unknown) => (h as Record<string, unknown>).command === `${HOOK_CMD} claude stop`,
      ),
    )).toBe(true);
  });

  it("handles malformed JSON in settings file gracefully (resets hooks section)", () => {
    const { opts, written } = makeInstallOpts({ existingRaw: "not-valid-json{{" });
    expect(() => installClaudeHooks(opts)).not.toThrow();
    expect(written).toHaveLength(1);
    const result = JSON.parse(written[0].content);
    expect(result.hooks.Stop).toBeDefined();
  });

  it("resets hooks when existing value is a non-object (e.g. null)", () => {
    const { opts, written } = makeInstallOpts({
      existingSettings: { hooks: null },
    });
    expect(() => installClaudeHooks(opts)).not.toThrow();
    expect(written).toHaveLength(1);
    const result = JSON.parse(written[0].content);
    expect(result.hooks.Stop).toBeDefined();
  });
});

// ── mapSubToLifecycle ─────────────────────────────────────────────────────────

describe("mapSubToLifecycle — pure mapping", () => {
  it("maps session-start → running", () => expect(mapSubToLifecycle("session-start")).toBe("running"));
  it("maps prompt-submit → running", () => expect(mapSubToLifecycle("prompt-submit")).toBe("running"));
  it("maps pre-tool-use → running", () => expect(mapSubToLifecycle("pre-tool-use")).toBe("running"));
  it("maps stop → idle", () => expect(mapSubToLifecycle("stop")).toBe("idle"));
  it("maps notification → needsInput", () => expect(mapSubToLifecycle("notification")).toBe("needsInput"));
  it("maps ask-question → needsInput", () => expect(mapSubToLifecycle("ask-question")).toBe("needsInput"));
  it("maps session-end → 'session-end' (teardown sentinel)", () => expect(mapSubToLifecycle("session-end")).toBe("session-end"));
  it("maps unknown sub → null (no-op)", () => {
    expect(mapSubToLifecycle("")).toBeNull();
    expect(mapSubToLifecycle("unknown-event")).toBeNull();
    expect(mapSubToLifecycle("Stop")).toBeNull();  // case-sensitive: Claude names vs aliases
  });
});

// ── NativeHookSource.handleHook ───────────────────────────────────────────────

describe("NativeHookSource — handleHook lifecycle state mapping", () => {
  it("session-start → state:running, alive:true, origin:agent", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("session-start", TASK_ID);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "running", alive: true, origin: "agent" });
  });

  it("prompt-submit → state:running, alive:true", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("prompt-submit", TASK_ID);
    expect(reports[0]).toMatchObject({ state: "running", alive: true });
  });

  it("stop → state:idle, alive:true", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("stop", TASK_ID);
    expect(reports[0]).toMatchObject({ state: "idle", alive: true });
  });

  it("notification → state:needsInput, alive:true", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("notification", TASK_ID);
    expect(reports[0]).toMatchObject({ state: "needsInput", alive: true });
  });

  it("ask-question → state:needsInput, alive:true", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("ask-question", TASK_ID);
    expect(reports[0]).toMatchObject({ state: "needsInput", alive: true });
  });

  it("session-end → state:unknown, alive:false (teardown — anti-#2576)", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("session-end", TASK_ID);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ state: "unknown", alive: false, origin: "agent" });
  });

  it("unknown sub → no report emitted", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("Stop", TASK_ID);   // wrong case — should be 'stop'
    src.handleHook("garbage", TASK_ID);
    src.handleHook("", TASK_ID);
    expect(reports).toHaveLength(0);
  });

  it("all reported snapshots carry origin:agent (never scan)", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    for (const sub of ["session-start", "prompt-submit", "pre-tool-use", "stop", "notification", "ask-question", "session-end"]) {
      src.handleHook(sub, TASK_ID);
    }
    for (const snap of reports) {
      expect(snap.origin).toBe("agent");
    }
  });
});

describe("NativeHookSource — handleHook payload extraction", () => {
  it("notification with payload.message → detail.note", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("notification", TASK_ID, undefined, { message: "Claude needs your permission" });

    expect(reports[0].detail?.note).toBe("Claude needs your permission");
  });

  it("notification with no message → no detail", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("notification", TASK_ID, undefined, {});

    expect(reports[0].detail).toBeUndefined();
  });

  it("pre-tool-use with payload.tool_name → detail.tool", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("pre-tool-use", TASK_ID, undefined, { tool_name: "Bash" });

    expect(reports[0].detail?.tool).toBe("Bash");
  });

  it("pre-tool-use with no tool_name → no detail", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("pre-tool-use", TASK_ID, undefined, {});

    expect(reports[0].detail).toBeUndefined();
  });

  it("stop with any payload → no detail (only notification and pre-tool-use extract detail)", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("stop", TASK_ID, undefined, { message: "some message" });

    expect(reports[0].detail).toBeUndefined();
  });

  it("null payload → no detail, no throw", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    expect(() => src.handleHook("notification", TASK_ID, undefined, null)).not.toThrow();
    expect(reports[0].detail).toBeUndefined();
  });
});

describe("NativeHookSource — handleHook pid", () => {
  it("carries pid when provided", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("stop", TASK_ID, 99001);

    expect(reports[0].pid).toBe(99001);
  });

  it("omits pid when not provided", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.handleHook("stop", TASK_ID);

    expect(reports[0].pid).toBeUndefined();
  });
});

describe("NativeHookSource — handleHook before start() (no deps)", () => {
  it("is a no-op — does not throw", () => {
    const { src } = makeSource();
    expect(() => src.handleHook("stop", TASK_ID)).not.toThrow();
  });
});

describe("NativeHookSource — at timestamp", () => {
  it("snapshot at field is a positive number (epoch ms)", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    const before = Date.now();
    src.handleHook("stop", TASK_ID);
    const after = Date.now();

    expect(reports[0].at).toBeGreaterThanOrEqual(before);
    expect(reports[0].at).toBeLessThanOrEqual(after);
  });
});

// ── NativeHookSource — snapshot() liveness floor ─────────────────────────────

describe("NativeHookSource — snapshot()", () => {
  it("returns the last-reported snapshot for a known taskId", () => {
    const { src } = makeSource();
    const { deps } = makeDeps();
    src.start(deps);
    src.handleHook("stop", TASK_ID);

    const snap = src.snapshot(TASK_ID);
    expect(snap).toBeDefined();
    expect(snap?.state).toBe("idle");
    expect(snap?.taskId).toBe(TASK_ID);
  });

  it("returns undefined for an unknown taskId", () => {
    const { src } = makeSource();
    const { deps } = makeDeps();
    src.start(deps);

    expect(src.snapshot("never-seen")).toBeUndefined();
  });

  it("reflects the latest handleHook call when called multiple times", () => {
    const { src } = makeSource();
    const { deps } = makeDeps();
    src.start(deps);
    src.handleHook("session-start", TASK_ID);
    src.handleHook("stop", TASK_ID);

    expect(src.snapshot(TASK_ID)?.state).toBe("idle");
  });

  it("cache is cleared on stop()", () => {
    const { src } = makeSource();
    const { deps } = makeDeps();
    src.start(deps);
    src.handleHook("stop", TASK_ID);
    src.stop();

    expect(src.snapshot(TASK_ID)).toBeUndefined();
  });
});

// ── NativeHookSource — LifecycleSource interface: start/stop ─────────────────

describe("NativeHookSource — start/stop", () => {
  it("does not report after stop()", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.stop();
    src.handleHook("stop", TASK_ID);

    expect(reports).toHaveLength(0);
  });

  it("resumes reporting after start() is called again", () => {
    const { src } = makeSource();
    const { deps, reports } = makeDeps();
    src.start(deps);
    src.stop();
    src.start(deps);
    src.handleHook("stop", TASK_ID);

    expect(reports).toHaveLength(1);
  });

  it("name is 'native-hook'", () => {
    const { src } = makeSource();
    expect(src.name).toBe("native-hook");
  });
});

// ── NativeHookSource — install() ─────────────────────────────────────────────

describe("NativeHookSource — install()", () => {
  it("delegates to installClaudeHooks and returns the settings path", () => {
    const { src, written } = makeSource();
    const returned = src.install();

    expect(returned).toBe(SETTINGS_PATH);
    expect(written).toHaveLength(1);
  });

  it("install() is idempotent when called twice", () => {
    const { opts, written } = makeInstallOpts();
    const src1 = new NativeHookSource({ hookInstall: opts });
    src1.install();
    const afterFirst = written[0].content;

    const { opts: opts2, written: written2 } = makeInstallOpts({ existingRaw: afterFirst });
    const src2 = new NativeHookSource({ hookInstall: opts2 });
    src2.install();

    expect(written2).toHaveLength(0);
  });
});
