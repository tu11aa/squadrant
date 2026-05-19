// src/control/__tests__/protocol-socket.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, sendRequest } from "../protocol.js";

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
});
