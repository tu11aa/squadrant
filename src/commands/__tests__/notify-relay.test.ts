// src/commands/__tests__/notify-relay.test.ts
//
// #111: the in-cmux relay subscribes to the daemon and forwards each pushed
// message to the project's captain via the runtime driver. This test stands
// up a one-shot daemon-like UDS server, runs the relay against it, and
// asserts each push frame produces a matching driver.send() call.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { runNotifyRelay } from "../notify-relay.js";
import { encodeMsg, createDecoder, encodeFrame } from "../../control/protocol.js";
import type { AttachFrame } from "../../control/protocol.js";

function startFakeDaemon(sockPath: string): { server: Server; firstConn: Promise<Socket>; subscribed: Promise<string> } {
  let resolveFirst!: (s: Socket) => void;
  let resolveSubscribed!: (p: string) => void;
  const firstConn = new Promise<Socket>((r) => { resolveFirst = r; });
  const subscribed = new Promise<string>((r) => { resolveSubscribed = r; });
  const server = createServer((conn) => {
    resolveFirst(conn);
    const dec = createDecoder();
    conn.setEncoding("utf-8");
    conn.on("data", (chunk: string) => {
      for (const msg of dec.push(chunk)) {
        const m = msg as { op?: string; project?: string };
        if (m.op === "subscribe-notify" && m.project) resolveSubscribed(m.project);
      }
    });
  });
  server.listen(sockPath);
  return { server, firstConn, subscribed };
}

describe("notify-relay (#111)", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("subscribes to the daemon for the given project and forwards each push to driver.send", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-relay-"));
    const sock = join(dir, "c.sock");
    const fake = startFakeDaemon(sock);

    const sent: string[] = [];
    // Run the relay against the fake daemon. opts.once = true makes it return
    // after the daemon closes the connection (so the test can deterministically
    // await completion).
    const relayDone = runNotifyRelay("proj-x", {
      sockPath: sock,
      once: true,
      resolve: async () => ({
        captainName: "⚓ proj-x-captain",
        send: async (msg) => { sent.push(msg); },
      }),
      log: () => { /* silence */ },
    });

    // Wait until the relay has sent the subscribe-notify claim.
    const project = await fake.subscribed;
    expect(project).toBe("proj-x");

    // Push three frames at the relay.
    const conn = await fake.firstConn;
    const push = (msg: string): void => {
      const frame: AttachFrame = { type: "push", project: "proj-x", message: msg, ts: Date.now() };
      conn.write(encodeFrame(frame));
    };
    push("CREW DONE [claude/abc12345]: done");
    push("CREW BLOCKED [claude/def67890]: which db?");
    push("CREW FAILED [claude/ghijklmn]: boom");

    // Give the relay an event-loop turn or two to process all three.
    await new Promise((r) => setTimeout(r, 50));

    // Close the conn so once-mode relay returns.
    conn.end();
    await relayDone;

    expect(sent).toEqual([
      "CREW DONE [claude/abc12345]: done",
      "CREW BLOCKED [claude/def67890]: which db?",
      "CREW FAILED [claude/ghijklmn]: boom",
    ]);

    fake.server.close();
  });

  it("ignores push frames for other projects", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-relay-"));
    const sock = join(dir, "c.sock");
    const fake = startFakeDaemon(sock);

    const sent: string[] = [];
    const relayDone = runNotifyRelay("proj-a", {
      sockPath: sock,
      once: true,
      resolve: async () => ({
        captainName: "⚓ proj-a-captain",
        send: async (msg) => { sent.push(msg); },
      }),
      log: () => { /* silence */ },
    });

    await fake.subscribed;
    const conn = await fake.firstConn;

    // Push frame for the WRONG project — relay should skip it.
    conn.write(encodeFrame({ type: "push", project: "proj-b", message: "not mine", ts: 1 }));
    // Push frame for the right project — relay should deliver it.
    conn.write(encodeFrame({ type: "push", project: "proj-a", message: "mine", ts: 2 }));

    await new Promise((r) => setTimeout(r, 50));
    conn.end();
    await relayDone;

    expect(sent).toEqual(["mine"]);
    fake.server.close();
  });
});

// Sanity check on the encoder so the test's encodeMsg import isn't unused
// (and to keep tree-shaking from dropping it).
void encodeMsg;
