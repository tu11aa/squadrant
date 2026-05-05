import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CockpitConfig, ReactionsConfig } from "../../config.js";
import type { RuntimeDriver } from "../../runtimes/types.js";
import { runAutoStatus } from "../auto-status.js";

function makeConfig(): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove: {
        path: "/tmp/brove",
        captainName: "brove-captain",
        spokeVault: "/tmp/spokes/brove",
        host: "local",
      },
      solder: {
        path: "/tmp/solder",
        captainName: "solder-captain",
        spokeVault: "/tmp/spokes/solder",
        host: "local",
      },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
  };
}

function makeReactions(overrides: Partial<ReactionsConfig["auto_status"]> = {}): ReactionsConfig {
  return {
    engine: { poll_interval: "5m", state_file: "/tmp/state.json", max_retries: 2 },
    github: { repos: {} },
    reactions: {},
    auto_status: { enabled: true, lines: 50, excerpt_lines: 10, ...overrides },
  };
}

function makeRuntime(screens: Record<string, string>): RuntimeDriver {
  return {
    name: "cmux",
    probe: vi.fn(),
    list: vi.fn(),
    status: vi.fn(),
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(async (ref: string) => screens[ref] ?? ""),
    stop: vi.fn(),
    newPane: vi.fn(),
    closePane: vi.fn(),
    sendToPane: vi.fn(),
    readPaneScreen: vi.fn(),
  };
}

describe("runAutoStatus", () => {
  let writes: Array<{ path: string; content: string }>;
  let writeFile: (p: string, c: string) => void;
  const NOW = "2026-05-05T12:00:00.000Z";

  beforeEach(() => {
    writes = [];
    writeFile = (p, c) => { writes.push({ path: p, content: c }); };
  });

  it("classifies and writes status.md for every registered project", async () => {
    const runtime = makeRuntime({
      "brove-captain": "│ > \nReady.\n",
      "solder-captain": "✻ Cogitating…\n",
    });
    const results = await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results).toEqual([
      { project: "brove",  state: "idle", vaultPath: "/tmp/spokes/brove/status.md" },
      { project: "solder", state: "busy", vaultPath: "/tmp/spokes/solder/status.md" },
    ]);
    expect(writes).toHaveLength(2);
  });

  it("writes frontmatter with auto_state, auto_last_checked, captain_workspace", async () => {
    const runtime = makeRuntime({ "brove-captain": "│ > \nReady.\n" });
    const cfg = makeConfig();
    delete cfg.projects.solder;

    await runAutoStatus({
      config: cfg,
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    const w = writes[0];
    expect(w.path).toBe("/tmp/spokes/brove/status.md");
    expect(w.content).toMatch(/^---$/m);
    expect(w.content).toContain("project: brove");
    expect(w.content).toContain("auto_state: idle");
    expect(w.content).toContain(`auto_last_checked: "${NOW}"`);
    expect(w.content).toContain("captain_workspace: brove-captain");
  });

  it("writes the activity excerpt in a fenced block", async () => {
    const runtime = makeRuntime({
      "brove-captain": "alpha\nbeta\ngamma\n│ > \n",
    });
    const cfg = makeConfig();
    delete cfg.projects.solder;

    await runAutoStatus({
      config: cfg,
      reactions: makeReactions({ excerpt_lines: 5 }),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(writes[0].content).toContain("## Last activity excerpt");
    expect(writes[0].content).toMatch(/```\nalpha\nbeta\ngamma\n│ >\n```/);
  });

  it("marks state offline when readScreen returns empty", async () => {
    const runtime = makeRuntime({});
    const cfg = makeConfig();
    delete cfg.projects.solder;

    const results = await runAutoStatus({
      config: cfg,
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results[0].state).toBe("offline");
    expect(writes[0].content).toContain("auto_state: offline");
  });

  it("skips polling when auto_status.enabled is false", async () => {
    const runtime = makeRuntime({ "brove-captain": "✻ Cogitating…\n" });
    const results = await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions({ enabled: false }),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results).toEqual([]);
    expect(writes).toEqual([]);
    expect(runtime.readScreen).not.toHaveBeenCalled();
  });

  it("continues polling other projects when one runtime call throws", async () => {
    const runtime: RuntimeDriver = {
      ...makeRuntime({}),
      readScreen: vi.fn(async (ref: string) => {
        if (ref === "brove-captain") throw new Error("runtime offline");
        return "│ > \nReady.\n";
      }),
    };
    const results = await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results).toEqual([
      { project: "brove",  state: "offline", vaultPath: "/tmp/spokes/brove/status.md" },
      { project: "solder", state: "idle",    vaultPath: "/tmp/spokes/solder/status.md" },
    ]);
  });

  it("uses the per-project runtime driver from the registry", async () => {
    const runtimePicker = vi.fn((): RuntimeDriver => makeRuntime({ "brove-captain": "│ > \n" }));
    await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions(),
      runtime: runtimePicker,
      now: () => NOW,
      writeFile,
    });

    expect(runtimePicker).toHaveBeenCalledWith("brove");
    expect(runtimePicker).toHaveBeenCalledWith("solder");
  });

  it("creates the spoke vault directory before writing", async () => {
    const runtime = makeRuntime({ "brove-captain": "│ > \n" });
    const mkdirs: string[] = [];
    const cfg = makeConfig();
    delete cfg.projects.solder;

    await runAutoStatus({
      config: cfg,
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
      mkdir: (p) => { mkdirs.push(p); },
    });

    expect(mkdirs).toContain("/tmp/spokes/brove");
  });
});
