import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelaySuperviseArgs, readRelayLogs } from "../relay.js";

function cleanSock(path: string) {
  if (existsSync(path)) try { unlinkSync(path); } catch { /* ignore */ }
}

describe("relay supervise", () => {
  it("buildRelaySuperviseArgs returns correct runNotifyRelay opts for a project", () => {
    const config = {
      projects: {
        brove: {
          captainName: "brove-captain",
          path: "/tmp/brove",
        },
      },
    };

    const opts = buildRelaySuperviseArgs({
      project: "brove",
      subscriber: "captain",
      config: config as never,
      stateRoot: "/tmp/state",
    });

    expect(opts.project).toBe("brove");
    expect(opts.subscriber).toBe("captain");
    expect(opts.captainName).toBe("brove-captain");
    expect(opts.stateRoot).toBe("/tmp/state");
  });

  it("buildRelaySuperviseArgs defaults subscriber to 'captain'", () => {
    const config = {
      projects: {
        brove: {
          captainName: "brove-captain",
          path: "/tmp/brove",
        },
      },
    };

    const opts = buildRelaySuperviseArgs({
      project: "brove",
      config: config as never,
      stateRoot: "/tmp/state",
    });

    expect(opts.subscriber).toBe("captain");
  });

  it("throws for unknown project", () => {
    const config = { projects: {} };

    expect(() =>
      buildRelaySuperviseArgs({
        project: "nope",
        config: config as never,
        stateRoot: "/tmp/state",
      }),
    ).toThrow(/unknown project/);
  });
});

describe("readRelayLogs", () => {
  it("streams lines from live socket to stdout", async () => {
    const sockPath = join(tmpdir(), "test-rl-stream.sock");
    cleanSock(sockPath);
    const received: string[] = [];
    const fakeStdout = { write: (s: string) => { received.push(s); return true; } };
    const fakeStderr = { write: (_s: string) => true };

    const server = createServer((conn) => {
      conn.write("line1\nline2\n");
      conn.end();
    });
    await new Promise<void>((res) => server.listen(sockPath, res));

    await readRelayLogs({
      sockPath,
      follow: false,
      stdout: fakeStdout as any,
      stderr: fakeStderr as any,
      sleep: () => Promise.resolve(),
    });

    expect(received.join("")).toContain("line1");
    expect(received.join("")).toContain("line2");
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  });

  it("ENOENT: writes friendly 'no live relay' error, does not throw", async () => {
    const sockPath = join(tmpdir(), "test-rl-noent.sock");
    const errors: string[] = [];
    const fakeStdout = { write: (_s: string) => true };
    const fakeStderr = { write: (s: string) => { errors.push(s); return true; } };

    await readRelayLogs({
      sockPath,
      follow: false,
      stdout: fakeStdout as any,
      stderr: fakeStderr as any,
      sleep: () => Promise.resolve(),
    });

    expect(errors.join("")).toMatch(/no live relay/i);
    expect(errors.join("")).not.toContain("ENOENT");
  });

  it("ECONNREFUSED: same friendly error as ENOENT", async () => {
    const sockPath = join(tmpdir(), "test-rl-econnrefused.sock");
    cleanSock(sockPath);
    const server = createServer(() => {});
    await new Promise<void>((res) => server.listen(sockPath, res));
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));

    const errors: string[] = [];
    const fakeStdout = { write: (_s: string) => true };
    const fakeStderr = { write: (s: string) => { errors.push(s); return true; } };

    await readRelayLogs({
      sockPath,
      follow: false,
      stdout: fakeStdout as any,
      stderr: fakeStderr as any,
      sleep: () => Promise.resolve(),
    });

    expect(errors.join("")).toMatch(/no live relay/i);
  });

  it("follow: retries until socket appears, then streams", async () => {
    const sockPath = join(tmpdir(), "test-rl-follow.sock");
    cleanSock(sockPath);
    const received: string[] = [];
    const fakeStdout = { write: (s: string) => { received.push(s); return true; } };
    const fakeStderr = { write: (_s: string) => true };

    let attempt = 0;
    let server: ReturnType<typeof createServer> | undefined;

    const sleep = async (_ms: number) => {
      attempt++;
      if (attempt === 2) {
        server = createServer((conn) => { conn.write("appeared\n"); conn.end(); });
        await new Promise<void>((res) => server!.listen(sockPath, res));
      }
    };

    await readRelayLogs({
      sockPath,
      follow: true,
      stdout: fakeStdout as any,
      stderr: fakeStderr as any,
      sleep,
      shouldContinue: () => attempt < 4,
    });

    expect(received.join("")).toContain("appeared");
    if (server) await new Promise<void>((res, rej) => server!.close((e) => (e ? rej(e) : res())));
  });
});
