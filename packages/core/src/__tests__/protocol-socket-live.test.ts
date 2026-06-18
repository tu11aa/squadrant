import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDaemonSocketLive } from "../protocol.js";

// Integration tests — use a real unix socket so we actually verify the
// connect-probe semantics (ENOENT vs ECONNREFUSED vs live accept).

let tmpDir: string;
const servers: Server[] = [];

function tmpSock(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));
  return join(tmpDir, "test.sock");
}

afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true }); } catch { /* already gone */ } }
  tmpDir = "";
});

describe("isDaemonSocketLive", () => {
  it("returns false when the socket file does not exist", async () => {
    const sock = join(tmpdir(), "no-such-path-cockpit-test.sock");
    const result = await isDaemonSocketLive(sock, 200);
    expect(result).toBe(false);
  });

  it("returns true when a server is actively listening on the socket", async () => {
    const sock = tmpSock();
    const srv = createServer(() => {});
    servers.push(srv);
    await new Promise<void>((res) => srv.listen(sock, res));

    const result = await isDaemonSocketLive(sock, 500);
    expect(result).toBe(true);
  });

  it("returns false after a server stops listening (stale/closed socket)", async () => {
    const sock = tmpSock();
    // Listen then close. On macOS Node cleans up the socket file on close;
    // on Linux it leaves a stale inode. Either way isDaemonSocketLive must
    // return false (ENOENT or ECONNREFUSED both resolve to false).
    const srv = createServer(() => {});
    await new Promise<void>((res) => srv.listen(sock, res));
    await new Promise<void>((res) => srv.close(() => res()));

    const result = await isDaemonSocketLive(sock, 500);
    expect(result).toBe(false);
  });
});
