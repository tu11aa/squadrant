import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRelayLogBroadcaster, relayLogSockPath } from "../relay-log-broadcaster.js";

const DIR = tmpdir();

describe("relayLogSockPath", () => {
  it("returns <dir>/relay-<project>.sock", () => {
    expect(relayLogSockPath("myproj", "/d")).toBe("/d/relay-myproj.sock");
  });
});

describe("createRelayLogBroadcaster", () => {
  it("log() with no clients does not throw", async () => {
    const b = await createRelayLogBroadcaster("rlb-t1", DIR);
    expect(() => b.log("hello")).not.toThrow();
    await b.close();
  });

  it("log() delivers line to connected client", async () => {
    const b = await createRelayLogBroadcaster("rlb-t2", DIR);
    const received: string[] = [];
    const client = createConnection(b.sockPath);
    await new Promise<void>((res) => client.on("connect", res));
    client.setEncoding("utf-8");
    client.on("data", (d: string) => received.push(d));

    b.log("hello relay");
    await new Promise((r) => setTimeout(r, 40));

    expect(received.join("")).toContain("hello relay\n");
    client.destroy();
    await b.close();
  });

  it("log() after client disconnects does not throw", async () => {
    const b = await createRelayLogBroadcaster("rlb-t3", DIR);
    const client = createConnection(b.sockPath);
    await new Promise<void>((res) => client.on("connect", res));
    client.destroy();
    await new Promise((r) => setTimeout(r, 40));

    expect(() => b.log("after gone")).not.toThrow();
    await b.close();
  });

  it("close() removes the socket file", async () => {
    const b = await createRelayLogBroadcaster("rlb-t4", DIR);
    expect(existsSync(b.sockPath)).toBe(true);
    await b.close();
    expect(existsSync(b.sockPath)).toBe(false);
  });

  it("boot succeeds when stale socket file exists (simulates prior kill -9)", async () => {
    const path = relayLogSockPath("rlb-t5", DIR);
    writeFileSync(path, "stale-data");

    const b = await createRelayLogBroadcaster("rlb-t5", DIR);
    expect(existsSync(b.sockPath)).toBe(true);
    await b.close();
  });
});
