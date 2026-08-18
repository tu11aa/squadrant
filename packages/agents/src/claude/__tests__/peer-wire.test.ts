import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildUserEnvelope, writeLine } from "../peer-wire.js";

/** A fake net.Socket. No real socket is ever opened — see the no-ambient-state rule. */
function fakeSocket(behaviour: "connect" | "enoent" | "hang") {
  const s = new EventEmitter() as any;
  s.written = [];
  s.write = (chunk: string, cb?: () => void) => { s.written.push(chunk); cb?.(); return true; };
  s.end = vi.fn();
  s.destroy = vi.fn();
  s.setTimeout = vi.fn();
  process.nextTick(() => {
    if (behaviour === "connect") s.emit("connect");
    if (behaviour === "enoent") s.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    // "hang" emits nothing.
  });
  return s;
}

describe("buildUserEnvelope", () => {
  it("produces the verified type:user envelope shape", () => {
    const e = buildUserEnvelope({
      sessionId: "ses_abc", from: "uds:/tmp/cc-socks/squadrantd.sock",
      content: "hello", msgId: "11111111-1111-4111-8111-111111111111",
    });
    expect(e).toEqual({
      msgV: 1,
      msg_id: "11111111-1111-4111-8111-111111111111",
      type: "user",
      priority: "next",
      session_id: "ses_abc",
      from: "uds:/tmp/cc-socks/squadrantd.sock",
      message: { role: "user", content: "hello" },
    });
  });

  it("omits session_id and from when not supplied rather than sending null", () => {
    const e = buildUserEnvelope({ content: "hi", msgId: "m1" }) as unknown as Record<string, unknown>;
    expect("session_id" in e).toBe(false);
    expect("from" in e).toBe(false);
  });

  it("NEVER includes a from-mode attestation", () => {
    // Global constraint: attesting from-mode="bypass" holds EVERY message.
    // This layer must not emit the field at all.
    const e = buildUserEnvelope({ content: "hi", msgId: "m1" }) as unknown as Record<string, unknown>;
    expect("from-mode" in e).toBe(false);
    expect("from_mode" in e).toBe(false);
  });

  it("rejects empty content — the receiver silently ignores it", () => {
    expect(() => buildUserEnvelope({ content: "", msgId: "m1" })).toThrow(/non-empty/);
  });
});

describe("writeLine", () => {
  it("writes exactly one newline-terminated JSON line", async () => {
    const sock = fakeSocket("connect");
    const r = await writeLine("/tmp/x.sock", { type: "user" }, { connect: () => sock });
    expect(r).toEqual({ ok: true });
    expect(sock.written).toEqual(['{"type":"user"}\n']);
  });

  it("maps ENOENT to gone — the session is dead, caller may fall back", async () => {
    const sock = fakeSocket("enoent");
    const r = await writeLine("/tmp/x.sock", { type: "user" }, { connect: () => sock });
    expect(r).toEqual({ ok: false, reason: "gone", error: expect.stringContaining("ENOENT") });
  });

  it("maps a hang to transport, not gone — retry is allowed only here", async () => {
    const sock = fakeSocket("hang");
    const r = await writeLine("/tmp/x.sock", { type: "user" }, { connect: () => sock, timeoutMs: 5 });
    expect(r).toEqual({ ok: false, reason: "transport", error: expect.stringContaining("timeout") });
  });

  it("refuses a line over the receiver's 1 MiB buffer cap", async () => {
    const sock = fakeSocket("connect");
    const huge = { type: "user", message: { role: "user", content: "x".repeat(1_048_600) } };
    const r = await writeLine("/tmp/x.sock", huge, { connect: () => sock });
    expect(r).toEqual({ ok: false, reason: "transport", error: expect.stringContaining("1 MiB") });
    expect(sock.written).toEqual([]);  // never even attempted
  });
});
