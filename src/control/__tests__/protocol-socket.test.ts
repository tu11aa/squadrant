// src/control/__tests__/protocol-socket.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import {
  startServer, sendRequest, encodeMsg, encodeFrame, defaultListenError,
  PROTOCOL_VERSION,
  type NetConn,
} from "../protocol.js";

describe("unix socket", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("client request gets server response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "c.sock");
    const server = startServer(sock, async (msg: any) => ({ echo: msg.ping }));
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    const res = await sendRequest(sock, { ping: "hi" });
    expect(res).toEqual({ echo: "hi" });
  });

  it("sendRequest rejects clearly when no daemon is listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "absent.sock");
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    await expect(sendRequest(sock, { ping: "x" })).rejects.toThrow(/control plane unavailable/i);
  });

  it("client receives rejection when handler throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "err.sock");
    const server = startServer(sock, async () => { throw new Error("handler failed"); });
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    await expect(sendRequest(sock, { ping: "x" })).rejects.toThrow("handler failed");
  });

  // Red-team #2 (High): an unhandled server 'error' became uncaughtException
  // and killed the daemon → crash-loop. It must route to onListenError, never
  // throw out of the process.
  it("server 'error' goes to the injected handler, not an uncaughtException", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "e.sock");
    const seen: Error[] = [];
    const server = startServer(sock, async () => ({}), (e) => seen.push(e));
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    // Simulate a listen/runtime server failure (e.g. EADDRINUSE race).
    expect(() => server.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }))).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toMatch(/EADDRINUSE/);
  });

  // ── ServerCallbacks / attach fan-out (spec §4.5/§4.6) ───────────────────

  it("back-compat: plain handler function still works with ServerCallbacks shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "bc.sock");
    // startServer with a plain function (original API)
    const server = startServer(sock, async (msg: any) => ({ echo: msg.ping }));
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    const res = await sendRequest(sock, { ping: "backcompat" });
    expect(res).toEqual({ echo: "backcompat" });
  });

  it("onAttach callback fires when client sends {op:'attach',taskId}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "att.sock");
    const attachedConns: NetConn[] = [];
    const attachFrames: any[] = [];
    const inboundFrames: any[] = [];

    const server = startServer(sock, {
      handler: async (msg: any) => ({ echo: msg.ping }),
      onAttach: (conn, frame) => { attachedConns.push(conn); attachFrames.push(frame); },
      onAttachInbound: (_conn, frame) => { inboundFrames.push(frame); },
    });
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(sock);
      conn.setEncoding("utf-8");
      conn.on("connect", () => {
        // Send attach frame — should claim the conn (no {ok,reply} comes back).
        conn.write(encodeMsg({ op: "attach", taskId: "task-1" }));
        // Then send an inbound say frame.
        conn.write(encodeMsg({ op: "say", taskId: "task-1", text: "hello" }));
        // Short delay then verify.
        setTimeout(() => { conn.destroy(); resolve(); }, 50);
      });
      conn.on("error", reject);
    });

    expect(attachedConns).toHaveLength(1);
    expect(attachFrames).toEqual([{ op: "attach", taskId: "task-1" }]);
    expect(inboundFrames).toEqual([{ op: "say", taskId: "task-1", text: "hello" }]);
  });

  it("regular req/res still works on non-attach connections when ServerCallbacks passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "mix.sock");
    const server = startServer(sock, {
      handler: async (msg: any) => ({ pong: msg.ping }),
      onAttach: () => { /* noop */ },
    });
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    const res = await sendRequest(sock, { ping: "world" });
    expect(res).toEqual({ pong: "world" });
  });

  it("onAttachClose fires when a claimed attach conn closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "cls.sock");
    const closed: NetConn[] = [];
    const server = startServer(sock, {
      handler: async () => ({}),
      onAttach: () => { /* claimed */ },
      onAttachClose: (conn) => { closed.push(conn); },
    });
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(sock);
      conn.setEncoding("utf-8");
      conn.on("connect", () => {
        conn.write(encodeMsg({ op: "attach", taskId: "task-close" }));
        setTimeout(() => { conn.destroy(); }, 20);
        setTimeout(() => resolve(), 60);
      });
      conn.on("error", reject);
    });

    expect(closed).toHaveLength(1);
  });
});

// ── PROTOCOL_VERSION handshake (#92) ─────────────────────────────────────────

describe("protocol version (#92)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("sendRequest stamps _v: PROTOCOL_VERSION on the outgoing request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "stamp.sock");
    let received: any;
    const server = startServer(sock, async (msg: any) => { received = msg; return "ok"; });
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    await sendRequest(sock, { kind: "test" });
    expect(typeof PROTOCOL_VERSION).toBe("number"); // must be a real number, not undefined
    expect(received._v).toBe(PROTOCOL_VERSION);
    expect(received.kind).toBe("test");
  });

  it("sendRequest accepts a reply with no _v field (pre-v1 backward compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "vbc.sock");
    const raw = createServer((conn) => {
      conn.setEncoding("utf-8");
      conn.on("data", () => conn.write(JSON.stringify({ ok: true, reply: "legacy" }) + "\n"));
      conn.on("error", () => {});
    });
    cleanup = () => { raw.close(); rmSync(dir, { recursive: true, force: true }); };
    raw.listen(sock);
    await expect(sendRequest(sock, { kind: "test" })).resolves.toBe("legacy");
  });

  it("sendRequest rejects with clear version-mismatch error when server _v differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "vmm.sock");
    const raw = createServer((conn) => {
      conn.setEncoding("utf-8");
      conn.on("data", () => conn.write(JSON.stringify({ ok: true, reply: "data", _v: 9999 }) + "\n"));
      conn.on("error", () => {});
    });
    cleanup = () => { raw.close(); rmSync(dir, { recursive: true, force: true }); };
    raw.listen(sock);
    await expect(sendRequest(sock, { kind: "test" })).rejects.toThrow(/cockpitd protocol v9999.*expects v1/i);
  });

  it("sendRequest resolves on the real reply when a keepalive arrives first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "kpb.sock");
    const raw = createServer((conn) => {
      conn.setEncoding("utf-8");
      conn.on("data", () => {
        conn.write(JSON.stringify({ type: "_keepalive" }) + "\n");
        setTimeout(() => conn.write(JSON.stringify({ ok: true, reply: "after-keepalive", _v: PROTOCOL_VERSION }) + "\n"), 20);
      });
      conn.on("error", () => {});
    });
    cleanup = () => { raw.close(); rmSync(dir, { recursive: true, force: true }); };
    raw.listen(sock);
    await expect(sendRequest(sock, { kind: "test" })).resolves.toBe("after-keepalive");
  });
});

// ── Keepalive framing (#94) ───────────────────────────────────────────────────

describe("keepalive framing (#94)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("startServer starts a 10s keepalive interval when an attach connection is claimed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "kai.sock");
    const intervals: Array<{ ms: number }> = [];
    const fakeSetInterval = (_fn: () => void, ms: number) => {
      intervals.push({ ms });
      return 0 as unknown as ReturnType<typeof setInterval>;
    };
    const server = startServer(
      sock,
      { handler: async () => ({}), onAttach: () => {} },
      defaultListenError,
      { setInterval: fakeSetInterval, clearInterval: () => {} },
    );
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(sock);
      conn.setEncoding("utf-8");
      conn.on("connect", () => {
        conn.write(encodeMsg({ op: "attach", taskId: "t-kai" }));
        setTimeout(() => { conn.destroy(); resolve(); }, 50);
      });
      conn.on("error", reject);
    });
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(10_000);
  });

  it("keepalive interval fires and writes { type: '_keepalive' } to the attach connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "kaw.sock");
    let intervalFn: (() => void) | undefined;
    const fakeSetInterval = (fn: () => void, _ms: number) => {
      intervalFn = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    };
    const server = startServer(
      sock,
      { handler: async () => ({}), onAttach: () => {} },
      defaultListenError,
      { setInterval: fakeSetInterval, clearInterval: () => {} },
    );
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(sock);
      conn.setEncoding("utf-8");
      conn.on("connect", () => conn.write(encodeMsg({ op: "attach", taskId: "t-kaw" })));
      conn.on("data", (c: string) => received.push(c));
      setTimeout(() => {
        intervalFn?.();
        setTimeout(() => { conn.destroy(); resolve(); }, 20);
      }, 30);
      conn.on("error", reject);
    });
    expect(received.join("")).toContain('"type":"_keepalive"');
  });

  it("keepalive interval is cleared when the attach connection closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "kac.sock");
    const cleared: unknown[] = [];
    const fakeSetInterval = (_fn: () => void, _ms: number) => 42 as unknown as ReturnType<typeof setInterval>;
    const fakeClearInterval = (id: ReturnType<typeof setInterval>) => cleared.push(id);
    const server = startServer(
      sock,
      { handler: async () => ({}), onAttach: () => {} },
      defaultListenError,
      { setInterval: fakeSetInterval, clearInterval: fakeClearInterval },
    );
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(sock);
      conn.setEncoding("utf-8");
      conn.on("connect", () => {
        conn.write(encodeMsg({ op: "attach", taskId: "t-kac" }));
        setTimeout(() => conn.destroy(), 20);
        setTimeout(() => resolve(), 60);
      });
      conn.on("error", reject);
    });
    expect(cleared).toContain(42);
  });
});
