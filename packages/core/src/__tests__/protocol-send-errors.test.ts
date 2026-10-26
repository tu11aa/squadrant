// sendRequest error phases (2026-10-26 restart audit): an error before the socket connected means the
// request never left this process (safe to retry); an error after it was written (ECONNRESET, EPIPE)
// means the daemon may already have acted on it, so it must never look like "cannot reach socket".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

class FakeConn extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn();
  setEncoding = vi.fn();
}
let conn: FakeConn;
vi.mock("node:net", async (orig) => ({ ...(await orig<typeof import("node:net")>()), createConnection: vi.fn(() => conn) }));

import { sendRequest, isSocketUnreachableError } from "../protocol.js";

const econn = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => { conn = new FakeConn(); });

describe("sendRequest error phases", () => {
  it("an error before connect is the unreachable error", async () => {
    const p = sendRequest("/x.sock", { kind: "event" }, 1000);
    conn.emit("error", econn("ECONNREFUSED"));
    const err = await p.catch((e: Error) => e);
    expect(isSocketUnreachableError(err)).toBe(true);
  });

  it("ECONNRESET after the request was written is 'may or may not have been delivered', not unreachable", async () => {
    const p = sendRequest("/x.sock", { kind: "event" }, 1000);
    conn.emit("connect");
    expect(conn.write).toHaveBeenCalledTimes(1);
    conn.emit("error", econn("ECONNRESET"));
    const err = await p.catch((e: Error) => e);
    expect(isSocketUnreachableError(err)).toBe(false);
    expect((err as Error).message).toMatch(/may or may not have been delivered/);
    expect((err as Error).message).toMatch(/ECONNRESET/);
  });
});
