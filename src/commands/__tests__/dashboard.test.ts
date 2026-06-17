import { describe, it, expect, vi, beforeEach } from "vitest";

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe: vi.fn(), list: vi.fn(), status: vi.fn(), spawn: vi.fn(),
    send: vi.fn(), sendKey: vi.fn(), readScreen: vi.fn(), stop: vi.fn(),
    newPane, closePane: vi.fn(), sendToPane, readPaneScreen: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private d: Record<string, unknown>) {}
    forProject() { return this.d.cmux; }
    global() { return this.d.cmux; }
    get(name: string) { return this.d[name]; }
    async probeAll() { return {}; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@cockpit/shared", async () => {
  const actual = await vi.importActual<typeof import("@cockpit/shared")>("@cockpit/shared");
  return { ...actual, loadConfig, resolveHome: (p: string) => p.replace(/^~/, process.env.HOME ?? "") };
});

const mockReadAllStatuses = vi.hoisted(() => vi.fn());
vi.mock("../../dashboard/read-status.js", () => ({
  readAllStatuses: mockReadAllStatuses,
}));

import { runDashboardOnce, runDashboardPane, runSyncHub } from "../dashboard.js";

const cfg = () => ({
  commandName: "command",
  hubVault: "/tmp/hub",
  projects: {
    brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "/tmp/spokes/brove", host: "local" },
  },
  defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
  metrics: { enabled: false, path: "" },
});

describe("runDashboardOnce", () => {
  let writes: string[];
  beforeEach(() => {
    writes = [];
    loadConfig.mockReturnValue(cfg());
    mockReadAllStatuses.mockResolvedValue([
      { project: "brove", state: "idle", lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "brove-captain", excerpt: "" },
    ]);
  });

  it("renders the grid for every registered project", async () => {
    await runDashboardOnce({
      now: () => "2026-05-05T12:00:30.000Z",
      write: (s) => writes.push(s),
    });
    const out = writes.join("");
    expect(out).toContain("brove");
    expect(out).toContain("idle");
  });

  it("renders the empty-projects message when no projects are registered", async () => {
    loadConfig.mockReturnValueOnce({ ...cfg(), projects: {} });
    mockReadAllStatuses.mockResolvedValueOnce([]);
    await runDashboardOnce({
      now: () => "2026-05-05T12:00:30.000Z",
      write: (s) => writes.push(s),
    });
    expect(writes.join("")).toContain("No projects registered");
  });
});

describe("runSyncHub", () => {
  let writes: Array<{ path: string; content: string }>;
  let mkdirs: string[];

  beforeEach(() => {
    writes = [];
    mkdirs = [];
    loadConfig.mockReturnValue(cfg());
    mockReadAllStatuses.mockResolvedValue([
      { project: "brove", state: "idle", lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "brove-captain", excerpt: "" },
    ]);
  });

  it("writes a hub mirror per project", async () => {
    const result = await runSyncHub({
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });
    expect(result).toEqual([{ project: "brove", hubPath: "/tmp/hub/projects/brove.md" }]);
    expect(writes[0].path).toBe("/tmp/hub/projects/brove.md");
    expect(writes[0].content).toContain("auto_state: idle");
  });
});

describe("runDashboardPane", () => {
  beforeEach(() => {
    newPane.mockReset();
    sendToPane.mockReset();
    execSyncMock.mockReset();
    loadConfig.mockReturnValue(cfg());
    execSyncMock.mockReturnValue("workspace:42 something");
    newPane.mockResolvedValue({ workspaceId: "workspace:42", surfaceId: "surface:9" });
  });

  it("opens a split pane in the current cmux workspace", async () => {
    await runDashboardPane({});
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:42",
      direction: "right",
      title: expect.stringContaining("dashboard"),
    }));
  });

  it("sends a refreshing loop command into the new pane", async () => {
    await runDashboardPane({});
    const sent = sendToPane.mock.calls[0][1] as string;
    expect(sent).toContain("cockpit dashboard --once");
    expect(sent).toContain("sleep 10");
    expect(sent).toMatch(/while true/i);
  });

  it("respects --direction and --interval overrides", async () => {
    await runDashboardPane({ direction: "down", interval: 5 });
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({ direction: "down" }));
    expect(sendToPane.mock.calls[0][1]).toContain("sleep 5");
  });

  it("throws when not inside a cmux workspace", async () => {
    execSyncMock.mockReturnValueOnce("not a workspace");
    await expect(runDashboardPane({})).rejects.toThrow(/cmux workspace/i);
  });
});
