import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeReceiptListener } from "../receipt-listener.js";

/** Fake net.Server + a helper to feed it a connection carrying NDJSON. */
function fakeServer() {
  const srv = new EventEmitter() as any;
  srv.listen = (_p: string, cb?: () => void) => { cb?.(); return srv; };
  srv.close = vi.fn((cb?: () => void) => cb?.());
  srv.feed = (lines: string) => {
    const conn = new EventEmitter() as any;
    conn.setEncoding = vi.fn();
    srv.emit("connection", conn);
    conn.emit("data", lines);
    conn.emit("end");
  };
  return srv;
}

const RECEIPT = (status: string, orig: string) => JSON.stringify({
  type: "control", action: "peer_message_status", status,
  reason: `r-${status}`, orig_msg_id: orig, msgV: 1, msg_id: "x",
}) + "\n";

describe("ClaudeReceiptListener", () => {
  it("advertises a uds: address in the receivers' socket directory", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/squadrantd.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    expect(l.address).toBe("uds:/tmp/cc-socks/squadrantd.sock");
  });

  it("resolves waitFor with a correlated held receipt", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    await l.start();
    const p = l.waitFor("m-1", 1000);
    srv.feed(RECEIPT("held", "m-1"));
    await expect(p).resolves.toEqual({ status: "held", reason: "r-held", origMsgId: "m-1" });
  });

  it("ignores a receipt for a different message", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    await l.start();
    const p = l.waitFor("m-1", 20);
    srv.feed(RECEIPT("held", "m-OTHER"));
    await expect(p).resolves.toBeUndefined();
  });

  it("resolves undefined on timeout — silence is ambiguous, never an error", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    await l.start();
    await expect(l.waitFor("m-1", 10)).resolves.toBeUndefined();
  });

  it("routes a late receipt (human approved a hold) to onLate", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    await l.start();
    const late: unknown[] = [];
    l.onLate((r) => late.push(r));
    await l.waitFor("m-2", 5);                 // times out first
    srv.feed(RECEIPT("delivered", "m-2"));     // ...then the human approves
    expect(late).toEqual([{ status: "delivered", reason: "r-delivered", origMsgId: "m-2" }]);
  });

  it("survives a partial line split across two data events", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    await l.start();
    const p = l.waitFor("m-3", 1000);
    const full = RECEIPT("denied", "m-3");
    const conn = new EventEmitter() as any;
    conn.setEncoding = vi.fn();
    srv.emit("connection", conn);
    conn.emit("data", full.slice(0, 20));
    conn.emit("data", full.slice(20));
    await expect(p).resolves.toEqual({ status: "denied", reason: "r-denied", origMsgId: "m-3" });
  });

  it("discards non-JSON and non-receipt frames without throwing", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: (h) => { srv.on("connection", h); return srv; } });
    await l.start();
    const p = l.waitFor("m-4", 30);
    srv.feed("not json\n" + JSON.stringify({ type: "control", action: "something_else" }) + "\n");
    await expect(p).resolves.toBeUndefined();
  });
});

// Live incident 2026-08-19: a leftover /tmp/cc-socks/squadrantd.sock made listen()
// emit EADDRINUSE as an 'error' EVENT. start() only wired the success callback, so
// the failure bypassed every caller's .catch, became an uncaughtException, and
// killed the daemon at boot — taking the control plane down for every project.
describe("start() failure handling (#667 slice 4 — daemon boot crash)", () => {
  function failingServer(code: string) {
    const srv = new EventEmitter() as any;
    srv.listen = () => { process.nextTick(() => srv.emit("error", Object.assign(new Error(code), { code }))); return srv; };
    srv.close = vi.fn();
    return srv;
  }

  it("REJECTS on a listen error instead of throwing out of band", async () => {
    const l = new ClaudeReceiptListener({
      socketPath: "/tmp/cc-socks/x.sock",
      createServer: () => failingServer("EADDRINUSE"),
    });
    await expect(l.start()).rejects.toThrow(/EADDRINUSE/);
  });

  it("unlinks a stale socket file before binding", async () => {
    const unlinked: string[] = [];
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({
      socketPath: "/tmp/cc-socks/stale.sock",
      createServer: () => srv,
      unlinkStale: (p) => unlinked.push(p),
    });
    await l.start();
    expect(unlinked).toEqual(["/tmp/cc-socks/stale.sock"]);
  });

  it("still starts when no unlinkStale is injected (optional dep)", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/y.sock", createServer: () => srv });
    await expect(l.start()).resolves.toBeUndefined();
  });
});
