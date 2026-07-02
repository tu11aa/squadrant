import { describe, it, expect, vi, beforeEach } from "vitest";

const status = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("@squadrant/workspaces", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe: vi.fn(),
    list: vi.fn(),
    status,
    spawn: vi.fn(),
    send,
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    forProject() { return this.drivers.cmux; }
    global() { return this.drivers.cmux; }
    get(name: string) { return (this.drivers as Record<string, unknown>)[name]; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", () => ({
  loadConfig,
}));

import { runPing } from "../ping.js";

const makeConfig = () => ({
  commandName: "command",
  hubVault: "~/hub",
  projects: {
    projA: { path: "/projects/a", captainName: "⚓ A-captain", spokeVault: "/spokes/a", host: "local" },
  },
  defaults: {
    maxCrew: 5,
    worktreeDir: ".worktrees",
    teammateMode: "in-process",
    permissions: { command: "auto", captain: "auto", crew: "auto" },
  },
  metrics: { enabled: false, path: "/tmp/metrics.json" },
});

describe("runPing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue(makeConfig());
  });

  it("rejects an unregistered project with a clear error", async () => {
    await expect(runPing("nope", "hello")).rejects.toThrow(/not found/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers the message via the runtime driver when the captain is running", async () => {
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });

    await runPing("projA", "hello from ping");

    expect(send).toHaveBeenCalledWith("ws-1", "hello from ping");
  });

  it("errors clearly when the target captain is not running (no auto-boot)", async () => {
    status.mockResolvedValue(null);

    await expect(runPing("projA", "hello")).rejects.toThrow(/not running/i);
    expect(send).not.toHaveBeenCalled();
  });
});
