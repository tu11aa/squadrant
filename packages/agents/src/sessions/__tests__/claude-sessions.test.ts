// Tests for claude session introspection (#669).
// Pure/injected — never touches the real ~/.claude/sessions.
import { describe, it, expect } from "vitest";
import { listClaudeSessions } from "../claude-sessions.js";

const alive = () => true;
const dead = () => false;

function readOf(map: Record<string, string>): (n: string) => string {
  return (n) => {
    if (!(n in map)) throw new Error("ENOENT");
    return map[n];
  };
}

describe("listClaudeSessions", () => {
  it("maps a live entry, carrying id/pid/cwd/status/address", () => {
    const rows = listClaudeSessions({
      readdir: () => ["20523.json"],
      readFile: readOf({
        "20523.json": JSON.stringify({
          pid: 20523,
          sessionId: "sess-1",
          cwd: "/repo",
          status: "idle",
          messagingSocketPath: "/tmp/cc-socks/20523.sock",
        }),
      }),
      isAlive: alive,
    });
    expect(rows).toEqual([
      {
        id: "sess-1",
        pid: 20523,
        cwd: "/repo",
        status: "idle",
        address: "/tmp/cc-socks/20523.sock",
      },
    ]);
  });

  it("reconciles a dead pid to status 'stale', not its frozen status (trap 4)", () => {
    const rows = listClaudeSessions({
      readdir: () => ["1.json"],
      readFile: readOf({ "1.json": JSON.stringify({ sessionId: "s", status: "busy", cwd: "/r" }) }),
      isAlive: dead,
    });
    expect(rows[0].status).toBe("stale");
  });

  it("renders a missing status as 'unknown', never 'idle' (trap 5)", () => {
    const rows = listClaudeSessions({
      readdir: () => ["1.json"],
      readFile: readOf({ "1.json": JSON.stringify({ entrypoint: "sdk-cli", cwd: "/r" }) }),
      isAlive: alive,
    });
    expect(rows[0].status).toBe("unknown");
  });

  it("falls back to the pid string as id when sessionId is absent", () => {
    const rows = listClaudeSessions({
      readdir: () => ["42.json"],
      readFile: readOf({ "42.json": JSON.stringify({ cwd: "/r", status: "idle" }) }),
      isAlive: alive,
    });
    expect(rows[0].id).toBe("42");
    expect(rows[0].pid).toBe(42);
  });

  it("returns [] when the registry dir is unreadable", () => {
    const rows = listClaudeSessions({
      readdir: () => {
        throw new Error("ENOENT");
      },
    });
    expect(rows).toEqual([]);
  });

  it("skips torn/malformed files instead of throwing", () => {
    const rows = listClaudeSessions({
      readdir: () => ["1.json", "2.json"],
      readFile: readOf({ "1.json": "{ not json", "2.json": JSON.stringify({ sessionId: "ok", status: "idle" }) }),
      isAlive: alive,
    });
    expect(rows.map((r) => r.id)).toEqual(["ok"]);
  });
});
