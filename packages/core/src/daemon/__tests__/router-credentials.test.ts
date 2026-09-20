import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRequest } from "../../protocol.js";
import { createServer } from "../server.js";
import type { DaemonContext } from "../context.js";
import type { RouterService } from "../../router/service.js";

function makeCtx(routerService: RouterService | undefined, sockPath: string): DaemonContext {
  return {
    sockPath,
    store: { put: vi.fn(), get: vi.fn() },
    log: vi.fn(),
    attachConns: new Map(),
    d: { handle: vi.fn() },
    routerService,
  } as unknown as DaemonContext;
}

const noopHandlers = {
  buildHealth: () => [],
  gatherSnapshotInputs: vi.fn(),
  cancelPromotionsFor: vi.fn(),
  broadcast: vi.fn(),
};

describe("daemon router-credentials dispatch", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("returns credentials from the router service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-rc-"));
    const sock = join(dir, "s.sock");
    const routerService = {
      health: vi.fn().mockResolvedValue({ ready: true, upstreamReachable: true }),
      credentialsFor: vi.fn().mockReturnValue({
        backend: "proxy",
        baseUrl: "http://127.0.0.1:5555",
        token: "tok",
      }),
    } as unknown as RouterService;
    const server = createServer(makeCtx(routerService, sock), noopHandlers);
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    const res = await sendRequest(sock, { kind: "router-credentials", project: "p", backend: "proxy" });

    expect(res).toEqual({ backend: "proxy", baseUrl: "http://127.0.0.1:5555", token: "tok" });
    expect(routerService.credentialsFor).toHaveBeenCalledWith("p", "proxy");
  });

  it("fails loud when the daemon has no router service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-rc-"));
    const sock = join(dir, "s.sock");
    const server = createServer(makeCtx(undefined, sock), noopHandlers);
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    await expect(
      sendRequest(sock, { kind: "router-credentials", project: "p", backend: "direct" }),
    ).rejects.toThrow(/no router service/);
  });
});

describe("daemon router-usage dispatch (#777)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("returns accumulated usage from the router service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ru-"));
    const sock = join(dir, "s.sock");
    const usage = {
      project: "p", requests: 2, costUsd: 0.02,
      models: { m: { requests: 2, costUsd: 0.02, inputTokens: 0, outputTokens: 0 } },
    };
    const routerService = { usage: vi.fn().mockReturnValue(usage) } as unknown as RouterService;
    const server = createServer(makeCtx(routerService, sock), noopHandlers);
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    const res = await sendRequest(sock, { kind: "router-usage", project: "p" });

    expect(res).toEqual(usage);
    expect(routerService.usage).toHaveBeenCalledWith("p");
  });

  it("returns null when the daemon has no router service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ru-"));
    const sock = join(dir, "s.sock");
    const server = createServer(makeCtx(undefined, sock), noopHandlers);
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    await expect(sendRequest(sock, { kind: "router-usage", project: "p" })).resolves.toBeNull();
  });
});
