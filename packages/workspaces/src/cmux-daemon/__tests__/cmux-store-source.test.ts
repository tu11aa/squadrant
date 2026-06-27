// Tests for CmuxStoreSource — LifecycleSource adapter for ~/.cmuxterm
//
// All filesystem and process-kill deps are injected so tests run without
// touching disk or real pids. Timer deps are injected for debounce tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CmuxStoreSource } from "../cmux-store-source.js";
import type { CmuxStoreSourceOpts } from "../cmux-store-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";

// ── fixtures ─────────────────────────────────────────────────────────────────

const CREW_CWD = "/home/user/worktrees/my-crew";
const CREW_PID = 12345;
const CREW_SESSION_ID = "a1b2c3d4-uuid";
const CREW_TASK_ID = "task-001";
const STORE_FILENAME = "claude-hook-sessions.json";

function makeSession(overrides: Partial<{
  agentLifecycle: string;
  pid: number;
  cwd: string;
  sessionId: string;
  isRestorable: boolean;
  lastBody: string;
  updatedAt: number;
}> = {}) {
  return {
    agentLifecycle: "idle",
    pid: CREW_PID,
    cwd: CREW_CWD,
    sessionId: CREW_SESSION_ID,
    isRestorable: true,
    updatedAt: 1782467498.596,
    ...overrides,
  };
}

function makeStoreFile(sessions: Record<string, ReturnType<typeof makeSession>>) {
  return JSON.stringify({ sessions });
}

/** Build a deps object that resolves by cwd and captures reports. */
function makeDeps(options: { resolveByTaskId?: string } = {}) {
  const reports: LifecycleSnapshot[] = [];
  const deps: LifecycleSourceDeps = {
    resolve: (hint) => {
      if (hint.cwd === CREW_CWD) return { id: options.resolveByTaskId ?? CREW_TASK_ID };
      return undefined;
    },
    report: (snap) => reports.push(snap),
    log: vi.fn(),
  };
  return { deps, reports };
}

/** Build CmuxStoreSource opts with all deps injected. */
function makeSource(overrides: Partial<CmuxStoreSourceOpts> & {
  storeContent?: string;
  lockExists?: boolean;
  pidAlive?: boolean;
  watchCb?: { capture: (cb: () => void) => void };
} = {}): CmuxStoreSource {
  const {
    storeContent = makeStoreFile({ [CREW_SESSION_ID]: makeSession() }),
    lockExists = false,
    pidAlive = true,
    watchCb,
    ...rest
  } = overrides;

  const timers: Array<{ fn: () => void; ms: number }> = [];
  return new CmuxStoreSource({
    stateDir: "/fake/.cmuxterm",
    debounceMs: 10,
    listFiles: () => [STORE_FILENAME],
    readFile: (path) => {
      if (path.endsWith(STORE_FILENAME)) return storeContent;
      return undefined;
    },
    fileExists: (path) => {
      if (path.endsWith(".lock")) return lockExists;
      return false;
    },
    isPidAlive: () => pidAlive,
    watchDir: (_, cb) => {
      watchCb?.capture(cb);
      return () => {};
    },
    scheduleTimer: (fn, ms) => {
      const id = { fn, ms } as unknown as ReturnType<typeof setTimeout>;
      timers.push({ fn, ms });
      return id;
    },
    cancelTimer: (_id) => {
      timers.pop();
    },
    log: () => {},
    ...rest,
  });
}

// ── test suites ───────────────────────────────────────────────────────────────

describe("CmuxStoreSource — basic snapshot reporting", () => {
  it("emits an agent snapshot for a running session", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ agentLifecycle: "running" }) }) });
    src.start(deps);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      taskId: CREW_TASK_ID,
      state: "running",
      origin: "agent",
      alive: true,
      pid: CREW_PID,
    });
  });

  it("emits an agent snapshot for an idle session", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ agentLifecycle: "idle" }) }) });
    src.start(deps);

    expect(reports[0]).toMatchObject({ state: "idle", origin: "agent" });
  });

  it("emits needsInput from store as origin:agent (authoritative, not filtered)", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ agentLifecycle: "needsInput" }) }) });
    src.start(deps);

    expect(reports[0]).toMatchObject({ state: "needsInput", origin: "agent" });
  });

  it("emits unknown for an unrecognised agentLifecycle value", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ agentLifecycle: "garbage" }) }) });
    src.start(deps);

    expect(reports[0]).toMatchObject({ state: "unknown", origin: "agent" });
  });

  it("includes lastBody in detail when present", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ lastBody: "Claude needs your permission" }) }) });
    src.start(deps);

    expect(reports[0].detail?.note).toBe("Claude needs your permission");
  });

  it("converts updatedAt (Unix float s) to epoch ms in the at field", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ updatedAt: 1782467498.596 }) }) });
    src.start(deps);

    expect(reports[0].at).toBe(1782467498596);
  });

  it("performs an initial scan on start() before any watch event", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource();
    src.start(deps);

    expect(reports).toHaveLength(1);
  });
});

describe("CmuxStoreSource — liveness + hibernation guard", () => {
  it("sets alive:true when pid is alive", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ pidAlive: true });
    src.start(deps);

    expect(reports[0].alive).toBe(true);
  });

  it("sets alive:false when pid is dead and isRestorable is false", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({
      storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ isRestorable: false }) }),
      pidAlive: false,
    });
    src.start(deps);

    expect(reports[0].alive).toBe(false);
  });

  it("sets alive:true when pid is dead but isRestorable:true (hibernated, not dead)", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({
      storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ isRestorable: true }) }),
      pidAlive: false,
    });
    src.start(deps);

    expect(reports[0].alive).toBe(true);
  });

  it("sets alive:false when pid is dead and isRestorable is absent", () => {
    const { deps, reports } = makeDeps();
    const session = makeSession() as Partial<ReturnType<typeof makeSession>>;
    delete session.isRestorable;
    const src = makeSource({
      storeContent: makeStoreFile({ [CREW_SESSION_ID]: session as ReturnType<typeof makeSession> }),
      pidAlive: false,
    });
    src.start(deps);

    expect(reports[0].alive).toBe(false);
  });
});

describe("CmuxStoreSource — correlation", () => {
  it("skips sessions that cannot be resolved", () => {
    const deps: LifecycleSourceDeps = {
      resolve: () => undefined,  // resolves nothing
      report: vi.fn(),
    };
    const src = makeSource();
    src.start(deps);

    expect(deps.report).not.toHaveBeenCalled();
  });

  it("emits for multiple sessions in the same file", () => {
    const { deps, reports } = makeDeps();
    const secondTaskId = "task-002";
    const secondCwd = "/home/user/worktrees/crew-b";
    const depsMulti: LifecycleSourceDeps = {
      resolve: (hint) => {
        if (hint.cwd === CREW_CWD) return { id: CREW_TASK_ID };
        if (hint.cwd === secondCwd) return { id: secondTaskId };
        return undefined;
      },
      report: (snap) => reports.push(snap),
    };
    const storeContent = makeStoreFile({
      [CREW_SESSION_ID]: makeSession({ cwd: CREW_CWD }),
      "other-session-id": makeSession({ cwd: secondCwd, sessionId: "other-session-id" }),
    });
    const src = makeSource({ storeContent });
    src.start(depsMulti);

    expect(reports).toHaveLength(2);
    const taskIds = reports.map((r) => r.taskId);
    expect(taskIds).toContain(CREW_TASK_ID);
    expect(taskIds).toContain(secondTaskId);
  });

  it("skips sessions missing required fields (sessionId, cwd, pid)", () => {
    const { deps, reports } = makeDeps();
    const badSession = { agentLifecycle: "running" } as ReturnType<typeof makeSession>;
    const src = makeSource({ storeContent: makeStoreFile({ bad: badSession }) });
    src.start(deps);

    expect(reports).toHaveLength(0);
  });
});

describe("CmuxStoreSource — lock file", () => {
  it("skips a store file when a .lock sibling exists", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ lockExists: true });
    src.start(deps);

    expect(reports).toHaveLength(0);
  });
});

describe("CmuxStoreSource — resilience", () => {
  it("does not throw or emit when the store file is malformed JSON", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ storeContent: "not-json-{{{" });
    expect(() => src.start(deps)).not.toThrow();
    expect(reports).toHaveLength(0);
  });

  it("does not throw when stateDir does not exist (listFiles returns [])", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource({ listFiles: () => [] });
    expect(() => src.start(deps)).not.toThrow();
    expect(reports).toHaveLength(0);
  });
});

describe("CmuxStoreSource — snapshot() liveness floor", () => {
  it("returns cached snapshot for a known taskId", () => {
    const { deps } = makeDeps();
    const src = makeSource({ storeContent: makeStoreFile({ [CREW_SESSION_ID]: makeSession({ agentLifecycle: "idle" }) }) });
    src.start(deps);

    const snap = src.snapshot(CREW_TASK_ID);
    expect(snap).toBeDefined();
    expect(snap?.state).toBe("idle");
    expect(snap?.taskId).toBe(CREW_TASK_ID);
  });

  it("returns undefined for an unknown taskId", () => {
    const { deps } = makeDeps();
    const src = makeSource();
    src.start(deps);

    expect(src.snapshot("unknown-task")).toBeUndefined();
  });

  it("cache is cleared on stop()", () => {
    const { deps } = makeDeps();
    const src = makeSource();
    src.start(deps);
    src.stop();

    expect(src.snapshot(CREW_TASK_ID)).toBeUndefined();
  });
});

describe("CmuxStoreSource — debounce and re-scan", () => {
  it("debounces rapid watch callbacks into a single scan", () => {
    const { deps, reports } = makeDeps();
    let capturedCb!: () => void;

    // Use a real setTimeout/clearTimeout pair but with controlled timing via vi
    vi.useFakeTimers();
    const src = new CmuxStoreSource({
      stateDir: "/fake/.cmuxterm",
      debounceMs: 50,
      listFiles: () => [STORE_FILENAME],
      readFile: () => makeStoreFile({ [CREW_SESSION_ID]: makeSession() }),
      fileExists: () => false,
      isPidAlive: () => true,
      watchDir: (_, cb) => {
        capturedCb = cb;
        return () => {};
      },
    });
    src.start(deps);

    // Initial scan fires once synchronously.
    const reportsAfterStart = reports.length;

    // Fire 3 rapid watch events — only one debounced scan should result.
    capturedCb();
    capturedCb();
    capturedCb();
    vi.advanceTimersByTime(100);

    vi.useRealTimers();
    // The debounced scan adds exactly 1 more batch of snapshots.
    expect(reports.length).toBe(reportsAfterStart + 1);
  });

  it("rescans when a watch event fires after debounce settles", () => {
    const { deps, reports } = makeDeps();
    let capturedCb!: () => void;

    vi.useFakeTimers();
    const src = new CmuxStoreSource({
      stateDir: "/fake/.cmuxterm",
      debounceMs: 50,
      listFiles: () => [STORE_FILENAME],
      readFile: () => makeStoreFile({ [CREW_SESSION_ID]: makeSession() }),
      fileExists: () => false,
      isPidAlive: () => true,
      watchDir: (_, cb) => {
        capturedCb = cb;
        return () => {};
      },
    });
    src.start(deps);
    const after1 = reports.length;

    capturedCb();
    vi.advanceTimersByTime(100);
    const after2 = reports.length;

    capturedCb();
    vi.advanceTimersByTime(100);

    vi.useRealTimers();
    expect(after2).toBe(after1 + 1);
    expect(reports.length).toBe(after2 + 1);
  });
});

describe("CmuxStoreSource — stop()", () => {
  it("does not emit after stop()", () => {
    const { deps, reports } = makeDeps();
    let capturedCb!: () => void;

    vi.useFakeTimers();
    const src = new CmuxStoreSource({
      stateDir: "/fake/.cmuxterm",
      debounceMs: 50,
      listFiles: () => [STORE_FILENAME],
      readFile: () => makeStoreFile({ [CREW_SESSION_ID]: makeSession() }),
      fileExists: () => false,
      isPidAlive: () => true,
      watchDir: (_, cb) => {
        capturedCb = cb;
        return () => {};
      },
    });
    src.start(deps);
    src.stop();
    const reportsAtStop = reports.length;

    capturedCb?.();
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    expect(reports.length).toBe(reportsAtStop);
  });
});
