// #709: the captain-bound channel must include session_id whenever the
// captain is resolvable in the registry, and omit it (never throw) when not.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ClaudePeerChannel } from "@squadrant/agents";
import { captainSessionIdFor, buildCaptainChannelWithRetry } from "../captain-channel-factory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captainSessionIdFor", () => {
  it("resolves the sessionId from the registry entry matching the captain's socket path", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) {
        return JSON.stringify({
          messagingSocketPath: "/tmp/cc-socks/squadrant-captain-demo.sock",
          sessionId: "sess-captain-1",
          status: "idle",
        });
      }
      throw new Error("ENOENT");
    });
    expect(captainSessionIdFor("demo")).toBe("sess-captain-1");
  });

  it("returns undefined, not throw, when the captain has not registered yet", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as any);
    expect(captainSessionIdFor("demo")).toBeUndefined();
  });
});

describe("captain envelope carries session_id end-to-end (#709)", () => {
  function channelWithSessionResolver(wire: ReturnType<typeof vi.fn>) {
    return new ClaudePeerChannel({
      socketPathFor: () => "/tmp/cc-socks/squadrant-captain-demo.sock",
      sessionIdFor: captainSessionIdFor,
      statusFor: () => ({ status: "idle", statusUpdatedAt: 1 }),
      wire,
      receipts: { address: "uds:/tmp/cc-socks/squadrantd-1.sock", waitFor: vi.fn().mockResolvedValue(undefined) },
      newMsgId: () => "m-1",
      sleep: vi.fn().mockResolvedValue(undefined),
      confirmWindowMs: 10,
    });
  }

  it("includes session_id when the captain is resolvable in the registry", async () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) {
        return JSON.stringify({
          messagingSocketPath: "/tmp/cc-socks/squadrant-captain-demo.sock",
          sessionId: "sess-captain-1",
          status: "idle",
        });
      }
      throw new Error("ENOENT");
    });
    const wire = vi.fn().mockResolvedValue({ ok: true });
    await channelWithSessionResolver(wire).send("demo", "CREW DONE: fix-706");
    const envelope = wire.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope.session_id).toBe("sess-captain-1");
  });

  it("omits session_id (does not throw) when the captain is not resolvable in the registry", async () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as any);
    const wire = vi.fn().mockResolvedValue({ ok: true });
    await expect(channelWithSessionResolver(wire).send("demo", "CREW DONE: fix-706")).resolves.toBeDefined();
    const envelope = wire.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope.session_id).toBeUndefined();
  });
});

// #712: a transient `listen EACCES` at boot used to log once and latch the
// daemon into pane-only delivery for its entire process lifetime, because
// (a) sharedReceiptListener() cached the listener BEFORE start() resolved, so
// every later call returned the never-started listener without retrying the
// bind, and (b) the one call site in squadrantd.ts never retried at all.
describe("sharedReceiptListener retry (#712)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function fakeServer(behavior: "fail" | "succeed") {
    const srv = new EventEmitter() as any;
    srv.listen = (_p: string, cb?: () => void) => {
      if (behavior === "fail") {
        process.nextTick(() => srv.emit("error", Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" })));
      } else {
        process.nextTick(() => cb?.());
      }
      return srv;
    };
    srv.close = vi.fn();
    srv.unref = () => {};
    return srv;
  }

  it("a later call retries the bind instead of returning the poisoned listener from a failed start()", async () => {
    let calls = 0;
    const createServerMock = vi.fn(() => (calls++ === 0 ? fakeServer("fail") : fakeServer("succeed")));
    vi.doMock("node:net", () => ({ createServer: createServerMock, connect: vi.fn() }));

    const { sharedReceiptListener } = await import("../captain-channel-factory.js");
    await expect(sharedReceiptListener()).rejects.toThrow(/EACCES/);
    // Before the #712 fix, this second call returned the same never-started
    // listener without calling createServer again — createServerMock would
    // have been called exactly once.
    const listener = await sharedReceiptListener();
    expect(listener).toBeDefined();
    expect(createServerMock).toHaveBeenCalledTimes(2);
  });
});

// #711: squadrantd binds a receipt socket but never registers a name for it in
// ~/.claude/sessions/<pid>.json, so the receiving Claude session cannot resolve
// the sender and wraps every daemon-sent lifecycle message in the anonymous
// "Another Claude session" framing plus its reduced-trust peer guardrail.
// Registering our own entry keyed to the socket we just bound fixes the
// rendering at the source.
describe("sender identity registration (#711)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function fakeServerSucceeding() {
    const srv = new EventEmitter() as any;
    srv.listen = (_p: string, cb?: () => void) => { process.nextTick(() => cb?.()); return srv; };
    srv.close = vi.fn();
    srv.unref = () => {};
    return srv;
  }

  function mockFs() {
    const writes: Array<{ path: string; body: any }> = [];
    const ops: string[] = [];
    vi.doMock("node:net", () => ({ createServer: vi.fn(() => fakeServerSucceeding()), connect: vi.fn() }));
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation((path: any, data: any) => {
      writes.push({ path: path.toString(), body: JSON.parse(data.toString()) });
      ops.push(`write:${path}`);
      return undefined as any;
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation((path: any) => {
      ops.push(`unlink:${path}`);
      return undefined as any;
    });
    return { writes, ops };
  }

  it("writes a ~/.claude/sessions/<pid>.json entry naming the socket it just bound", async () => {
    const { writes } = mockFs();
    const { sharedReceiptListener } = await import("../captain-channel-factory.js");
    await sharedReceiptListener();
    expect(writes).toHaveLength(1);
    const { path, body } = writes[0];
    const expected = require("node:path").join(require("node:os").homedir(), ".claude", "sessions", `${process.pid}.json`);
    expect(path).toBe(expected);
    expect(body.name).toBe("squadrantd");
    expect(body.pid).toBe(process.pid);
    expect(body.messagingSocketPath).toMatch(/squadrantd-\d+\.sock$/);
    expect(typeof body.sessionId).toBe("string");
  });

  it("declares an honest kind and no stale-prone status fields (#711 review)", async () => {
    const { writes } = mockFs();
    const { sharedReceiptListener } = await import("../captain-channel-factory.js");
    await sharedReceiptListener();
    const body = writes[0].body;
    // "daemon" is in Claude's own registry-kind allowlist (2.1.241) — not a lie.
    expect(body.kind).toBe("daemon");
    // Never refreshed ⇒ would read as a live-but-frozen session. Omit entirely.
    expect(body.statusUpdatedAt).toBeUndefined();
    expect(body.status).toBeUndefined();
  });

  it("unlinks any pre-existing entry for our pid before writing (pid reuse)", async () => {
    const { ops } = mockFs();
    const { sharedReceiptListener } = await import("../captain-channel-factory.js");
    await sharedReceiptListener();
    const expected = require("node:path").join(require("node:os").homedir(), ".claude", "sessions", `${process.pid}.json`);
    // The stale-entry unlink for our own pid happens BEFORE the fresh write.
    expect(ops.indexOf(`unlink:${expected}`)).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf(`unlink:${expected}`)).toBeLessThan(ops.indexOf(`write:${expected}`));
  });

  it("removes the entry on process exit so a clean shutdown leaves no stale identity", async () => {
    const { ops } = mockFs();
    const handlers: Array<() => void> = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      if (event === "exit") handlers.push(handler);
      return process;
    }) as any);
    try {
      const { sharedReceiptListener } = await import("../captain-channel-factory.js");
      await sharedReceiptListener();
      expect(handlers).toHaveLength(1);
      handlers[0]();
      const expected = require("node:path").join(require("node:os").homedir(), ".claude", "sessions", `${process.pid}.json`);
      expect(ops).toContain(`unlink:${expected}`);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("a failed bind never writes a registry entry", async () => {
    const { writes } = mockFs();
    vi.doMock("node:net", () => ({
      createServer: vi.fn(() => {
        const srv = new EventEmitter() as any;
        srv.listen = (_p: string, _cb?: () => void) => {
          process.nextTick(() => srv.emit("error", Object.assign(new Error("listen EACCES"), { code: "EACCES" })));
          return srv;
        };
        srv.close = vi.fn();
        srv.unref = () => {};
        return srv;
      }),
      connect: vi.fn(),
    }));
    const { sharedReceiptListener } = await import("../captain-channel-factory.js");
    await expect(sharedReceiptListener()).rejects.toThrow(/EACCES/);
    expect(writes).toHaveLength(0);
  });

  it("a registry write failure degrades to the old anonymous-wrapper behaviour instead of killing the channel", async () => {
    mockFs();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("EACCES"); });
    const { sharedReceiptListener } = await import("../captain-channel-factory.js");
    await expect(sharedReceiptListener()).resolves.toBeDefined();
  });
});

describe("buildCaptainChannelWithRetry (#712 — transient bind failure recovers instead of latching)", () => {
  it("retries with capped exponential backoff until build() succeeds", async () => {
    let attempt = 0;
    const fakeChannel = {} as ClaudePeerChannel;
    const build = vi.fn(async () => {
      attempt++;
      if (attempt < 3) throw Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" });
      return fakeChannel;
    });
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const logs: string[] = [];

    const result = await buildCaptainChannelWithRetry({
      build, sleep, log: (m) => logs.push(m),
      initialDelayMs: 100, maxDelayMs: 1000,
    });

    expect(result).toBe(fakeChannel);
    expect(build).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]); // capped exponential backoff between the 2 failures
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/EACCES/);
  });

  it("never gives up — recovers past many consecutive failures rather than latching permanently", async () => {
    let attempt = 0;
    const fakeChannel = {} as ClaudePeerChannel;
    const build = vi.fn(async () => {
      attempt++;
      if (attempt < 8) throw new Error("listen EACCES: permission denied");
      return fakeChannel;
    });
    const sleep = vi.fn(async () => {});

    const result = await buildCaptainChannelWithRetry({ build, sleep, log: () => {} });

    expect(result).toBe(fakeChannel);
    expect(build).toHaveBeenCalledTimes(8);
  });

  it("caps the backoff delay instead of growing it unboundedly", async () => {
    let attempt = 0;
    const build = vi.fn(async () => {
      attempt++;
      if (attempt < 5) throw new Error("EACCES");
      return {} as ClaudePeerChannel;
    });
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });

    await buildCaptainChannelWithRetry({ build, sleep, log: () => {}, initialDelayMs: 1000, maxDelayMs: 3000 });

    expect(delays).toEqual([1000, 2000, 3000, 3000]);
  });
});
