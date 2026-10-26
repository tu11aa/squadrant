// packages/core/src/__tests__/restart-attribution.test.ts
//
// 2026-10-26: twelve SIGTERM restarts in one morning and the daemon log never said
// who caused them. Every path that restarts, reregisters or kickstarts the daemon
// must write one attribution line BEFORE it touches launchctl.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  constants: { O_EXCL: 2048, O_CREAT: 512, O_WRONLY: 1 },
}));
const order: string[] = [];
vi.mock("../restart-trigger.js", async (orig) => ({
  ...(await orig<typeof import("../restart-trigger.js")>()),
  logRestartTrigger: vi.fn((action: string, reason: string) => { order.push(`trigger ${action} | ${reason}`); }),
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { ensureDaemon, reregisterDaemon, daemonEntryPath, renderPlist, buildDaemonPath, describeDrift, _resetRestartInFlightForTest } from "../launchd.js";
import { restartDaemonIfRunning } from "../restart-daemon.js";
import { logRestartTrigger, formatRestartTrigger } from "../restart-trigger.js";

const NODE = "/usr/local/bin/node";
let plistOnDisk: string | null;

beforeEach(() => {
  vi.resetAllMocks();
  order.length = 0;
  _resetRestartInFlightForTest();
  vi.mocked(logRestartTrigger).mockImplementation((action, reason) => { order.push(`trigger ${action} | ${reason}`); });
  vi.mocked(existsSync).mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.includes("daemon.lock")) return false;
    if (s.endsWith(".plist")) return plistOnDisk !== null;
    return true;
  });
  vi.mocked(openSync).mockReturnValue(1 as unknown as number);
  vi.mocked(readFileSync).mockImplementation((p: unknown) => {
    if (String(p).endsWith(".plist") && plistOnDisk !== null) return plistOnDisk;
    throw new Error(`unexpected readFileSync(${p})`);
  });
  // The plist write "lands": a later process reads what an earlier one wrote.
  vi.mocked(writeFileSync).mockImplementation(((p: unknown, data: unknown) => {
    if (String(p).endsWith(".plist")) plistOnDisk = String(data);
  }) as typeof writeFileSync);
  vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args?: readonly string[]) => {
    if (cmd === "launchctl") {
      order.push(`launchctl ${args?.join(" ")}`);
      if (args?.[0] === "print") return "pid = 1\n";
      return "";
    }
    throw new Error("not found"); // `which <bin>` — no agent bins
  }) as unknown as typeof execFileSync);
  process.env.SQUADRANT_ROLE = "captain";
});

afterEach(() => {
  delete process.env.SQUADRANT_ROLE;
});

const thisEntry = () => daemonEntryPath();
const desiredPlist = () => renderPlist(NODE, thisEntry(), buildDaemonPath(process.env.PATH ?? ""));

describe("ensureDaemon attribution", () => {
  it("logs who/why before a program-arg bootout, naming the caller and the entry drift", () => {
    plistOnDisk = renderPlist(NODE, "/gone/squadrant/dist/squadrantd.js", buildDaemonPath(process.env.PATH ?? ""));
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("daemon.lock") || s.startsWith("/gone/")) return false;
      return true;
    });
    ensureDaemon(NODE, { caller: "cli startup" });
    expect(order[0]).toMatch(/^trigger bootout\+bootstrap \| ensureDaemon cli startup; drift=path \(entry \/gone\/.* -> /);
    expect(order.slice(1).some((l) => l.startsWith("launchctl bootout"))).toBe(true);
  });

  it("logs a PATH-only plist rewrite as a no-restart action", () => {
    plistOnDisk = renderPlist(NODE, thisEntry(), "/old/path");
    ensureDaemon(NODE, { caller: "squadrantdCall fallback" });
    expect(order[0]).toBe("trigger plist-write (no restart) | ensureDaemon squadrantdCall fallback; drift=plist (PATH/env only)");
    expect(order.some((l) => l.startsWith("launchctl bootout"))).toBe(false);
  });

  it("logs nothing when there is no drift (plain kickstart is a no-op for a running daemon)", () => {
    plistOnDisk = desiredPlist();
    ensureDaemon(NODE);
    expect(logRestartTrigger).not.toHaveBeenCalled();
    expect(order.some((l) => l.includes("-k") || l.startsWith("launchctl bootout"))).toBe(false);
  });

  it("restart storm: a second captain process with the same drift finds the plist already reconciled — one bootout total", () => {
    plistOnDisk = renderPlist(NODE, "/gone/squadrant/dist/squadrantd.js", buildDaemonPath(process.env.PATH ?? ""));
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("daemon.lock") || s.startsWith("/gone/")) return false;
      return true;
    });
    ensureDaemon(NODE, { caller: "cli startup" });
    _resetRestartInFlightForTest(); // a separate process
    ensureDaemon(NODE, { caller: "cli startup" });
    expect(order.filter((l) => l.startsWith("launchctl bootout"))).toHaveLength(1);
    expect(vi.mocked(logRestartTrigger)).toHaveBeenCalledTimes(1);
  });
});

describe("reregisterDaemon (heal daemon) attribution", () => {
  it("logs before reconcile and before kickstart -k, even with no drift", () => {
    plistOnDisk = desiredPlist();
    let pid = 100;
    vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args?: readonly string[]) => {
      if (cmd !== "launchctl") throw new Error("not found");
      order.push(`launchctl ${args?.join(" ")}`);
      if (args?.[0] === "print") return `pid = ${pid}\n`;
      if (args?.[1] === "-k") pid = 200;
      return "";
    }) as unknown as typeof execFileSync);
    reregisterDaemon(NODE, { pollDelayMs: 0 });
    const t = order.findIndex((l) => l.startsWith("trigger "));
    expect(order[t]).toBe("trigger reregister+kickstart-k | heal daemon; drift=none");
    expect(t).toBeLessThan(order.findIndex((l) => l.startsWith("launchctl bootstrap")));
    expect(t).toBeLessThan(order.findIndex((l) => l.startsWith("launchctl kickstart -k")));
  });
});

describe("restartDaemonIfRunning (config set / projects add / telegram setup) attribution", () => {
  it("logs the reason before kickstart -k", () => {
    restartDaemonIfRunning({ reason: "project registration", env: {}, isRunning: () => true, log: () => {} });
    expect(order[0]).toBe("trigger kickstart-k | project registration");
    expect(order[1]).toMatch(/^launchctl kickstart -k gui\/\d+\/com\.squadrant\.daemon$/);
  });
});

describe("formatRestartTrigger", () => {
  it("records pid, ppid, subcommand, role, crew task and install path on one line", () => {
    const line = formatRestartTrigger(
      "kickstart-k",
      "project registration",
      { pid: 42, ppid: 7, argv: ["/n/node", "/g/squadrant/dist/index.js", "projects", "add", "x"], env: { SQUADRANT_ROLE: "captain", SQUADRANT_CREW_TASK_ID: "t-1" } },
      new Date("2026-10-26T08:34:53.150Z"),
    );
    expect(line).toBe(
      '[squadrant-cli] 2026-10-26T08:34:53.150Z restart-trigger action=kickstart-k reason="project registration" ' +
      'pid=42 ppid=7 argv="projects add" role=captain crewTask=t-1 install=/g/squadrant/dist/index.js\n',
    );
  });

  it("uses '-' for an unset role / crew task", () => {
    const line = formatRestartTrigger("x", "y", { pid: 1, ppid: 1, argv: ["n", "i"], env: {} });
    expect(line).toContain("role=- crewTask=-");
  });
});

describe("describeDrift", () => {
  const p = (entry: string, node = NODE, path = "") => renderPlist(node, entry, path);
  it("classifies a same-manager version bump as version", () => {
    const was = "/s/.pnpm/squadrant@0.31.0/node_modules/squadrant/dist/squadrantd.js";
    const now = "/s/.pnpm/squadrant@0.31.1/node_modules/squadrant/dist/squadrantd.js";
    expect(describeDrift({ current: p(was), desired: p(now), changed: true, programChanged: true })).toBe(`version (entry ${was} -> ${now})`);
  });
  it("classifies a node binary change as path", () => {
    expect(describeDrift({ current: p("/e.js", "/a/node"), desired: p("/e.js", "/b/node"), changed: true, programChanged: true })).toBe("path (node /a/node -> /b/node)");
  });
  it("reports a missing plist and no drift", () => {
    expect(describeDrift({ current: null, desired: p("/e.js"), changed: true, programChanged: false })).toBe("plist missing");
    expect(describeDrift({ current: p("/e.js"), desired: p("/e.js"), changed: false, programChanged: false })).toBe("none");
  });
});
