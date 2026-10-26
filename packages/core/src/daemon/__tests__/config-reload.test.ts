import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { getDefaultConfig, type SquadrantConfig, type ProjectConfig } from "@squadrant/shared";
import { reloadDaemonConfig } from "../config-reload.js";
import { createRouterService, type RouterService } from "../../router/service.js";
import { startServer } from "../../protocol.js";
import { reloadOrRestartDaemon } from "../../restart-daemon.js";

const proj = (name: string): ProjectConfig => ({ path: `/tmp/${name}`, captainName: `${name}-captain` } as ProjectConfig);
const cfgWith = (...names: string[]): SquadrantConfig => {
  const c = getDefaultConfig();
  c.projects = Object.fromEntries(names.map((n) => [n, proj(n)]));
  return c;
};

describe("reloadDaemonConfig", () => {
  it("reports the registry and tops up router tokens for new projects only", () => {
    const router = createRouterService({ kind: "custom", baseUrl: "https://x.test", apiKey: "k" }, ["a"]);
    const logs: string[] = [];
    const res = reloadDaemonConfig({ routerService: router, log: (m) => logs.push(m) }, () => cfgWith("a", "b"));
    expect(res).toEqual({ projects: ["a", "b"], routerAdded: ["b"] });
    expect(logs[0]).toContain("router tokens added for b");
    expect(reloadDaemonConfig({ routerService: router, log: () => {} }, () => cfgWith("a", "b")).routerAdded).toEqual([]);
  });

  it("works without a router service", () => {
    expect(reloadDaemonConfig({ log: () => {} }, () => cfgWith("a")).projects).toEqual(["a"]);
  });
});

describe("reloadOrRestartDaemon", () => {
  const env = {} as NodeJS.ProcessEnv;
  let dir = ""; let server: Server | undefined; let router: RouterService | undefined;
  afterEach(async () => { server?.close(); server = undefined; await router?.stop(); router = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("projects add against a live daemon socket: reloads, never kickstarts, new project gets a router token", async () => {
    dir = mkdtempSync(join(tmpdir(), "reload-"));
    const sock = join(dir, "d.sock");
    router = createRouterService({ kind: "custom", baseUrl: "https://x.test", apiKey: "k" }, ["a"]);
    await router.start();
    let disk = cfgWith("a");
    server = startServer(sock, async (msg: any) => {
      if (msg.kind === "config-reload") return reloadDaemonConfig({ routerService: router, log: () => {} }, () => disk);
      throw new Error("unexpected");
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(() => router!.credentialsFor("b", "proxy")).toThrow(/no token for project 'b'/);

    disk = cfgWith("a", "b"); // what `projects add b` writes
    let kicked = false;
    const out = await reloadOrRestartDaemon({
      reason: "project registration", liveReloadable: true, env, sockPath: sock, isRunning: () => true,
      runKickstart: () => { kicked = true; }, log: () => {},
    });
    expect(out).toBe("reloaded");
    expect(kicked).toBe(false);
    expect(router.credentialsFor("b", "proxy").token).toBeTruthy();
  });

  it("falls back to a restart when the socket is unreachable", async () => {
    const reasons: string[] = [];
    const out = await reloadOrRestartDaemon({
      reason: "project registration", liveReloadable: true, env, sockPath: "/nonexistent/d.sock",
      isRunning: () => true, runKickstart: (r) => reasons.push(r), log: () => {},
    });
    expect(out).toBe("restarted");
    expect(reasons).toEqual(["project registration"]);
  });

  it("restarts, without trying a reload, for a boot-cached key", async () => {
    let reloaded = false; const reasons: string[] = [];
    const out = await reloadOrRestartDaemon({
      reason: "config telegram.x", liveReloadable: false, env, isRunning: () => true,
      reload: async () => { reloaded = true; }, runKickstart: (r) => reasons.push(r), log: () => {},
    });
    expect(out).toBe("restarted");
    expect(reloaded).toBe(false);
    expect(reasons).toEqual(["config telegram.x"]);
  });

  it("honours not-running and opt-out", async () => {
    const base = { reason: "r", liveReloadable: true, env, log: () => {}, reload: async () => { throw new Error("no"); } };
    expect(await reloadOrRestartDaemon({ ...base, isRunning: () => false })).toBe("skipped-not-running");
    expect(await reloadOrRestartDaemon({ ...base, isRunning: () => true, noRestart: true })).toBe("skipped-opt-out");
  });
});
