// Tests for opencode session introspection (#669).
// The "registry" for an opencode captain is the #786/#789 captain record.
import { describe, it, expect } from "vitest";
import { listOpencodeSessions } from "../opencode-sessions.js";

function reader(map: Record<string, string>) {
  return (p: string) => {
    if (!(p in map)) throw new Error("ENOENT");
    return map[p];
  };
}

describe("listOpencodeSessions", () => {
  it("maps an opencode captain record to an AgentSession", () => {
    const rows = listOpencodeSessions({
      stateRoot: "/state",
      readdir: () => ["squadrant"],
      readFile: reader({
        "/state/squadrant/captain.json": JSON.stringify({
          agent: "opencode",
          port: 49526,
          sessionId: "ses_abc",
          directory: "/Users/x/me/squadrant",
          launchedAt: "2026-09-18T04:02:45.782Z",
        }),
      }),
    });
    expect(rows).toEqual([
      {
        id: "ses_abc",
        cwd: "/Users/x/me/squadrant",
        status: "recorded",
        address: "http://127.0.0.1:49526",
        project: "squadrant",
      },
    ]);
  });

  it("ignores captain records that are not opencode", () => {
    const rows = listOpencodeSessions({
      stateRoot: "/state",
      readdir: () => ["brove"],
      readFile: reader({
        "/state/brove/captain.json": JSON.stringify({ agent: "claude", directory: "/r", launchedAt: "x" }),
      }),
    });
    expect(rows).toEqual([]);
  });

  it("synthesizes an id when sessionId is not yet resolved (cold start)", () => {
    const rows = listOpencodeSessions({
      stateRoot: "/state",
      readdir: () => ["p"],
      readFile: reader({ "/state/p/captain.json": JSON.stringify({ agent: "opencode", port: 1 }) }),
    });
    expect(rows[0].id).toBe("captain:p");
    expect(rows[0].address).toBe("http://127.0.0.1:1");
  });

  it("omits address and cwd when the record lacks port/directory", () => {
    const rows = listOpencodeSessions({
      stateRoot: "/state",
      readdir: () => ["p"],
      readFile: reader({ "/state/p/captain.json": JSON.stringify({ agent: "opencode", sessionId: "s" }) }),
    });
    expect(rows[0]).toEqual({ id: "s", status: "recorded", project: "p" });
  });

  it("returns [] when the state root is unreadable", () => {
    const rows = listOpencodeSessions({
      stateRoot: "/nope",
      readdir: () => {
        throw new Error("ENOENT");
      },
    });
    expect(rows).toEqual([]);
  });

  it("skips malformed captain.json without throwing", () => {
    const rows = listOpencodeSessions({
      stateRoot: "/state",
      readdir: () => ["a", "b"],
      readFile: reader({
        "/state/a/captain.json": "{ not json",
        "/state/b/captain.json": JSON.stringify({ agent: "opencode", sessionId: "ok" }),
      }),
    });
    expect(rows.map((r) => r.id)).toEqual(["ok"]);
  });
});
