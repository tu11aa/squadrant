import { describe, it, expect, vi } from "vitest";
import { newestSessionInDirectory, listSessions } from "../opencode-session.js";

const rows = [
  { id: "ses_crew", directory: "/tmp/proj/.worktrees/wt1", time: { updated: 300 } },
  { id: "ses_cap_old", directory: "/tmp/proj", time: { updated: 100 } },
  { id: "ses_cap_new", directory: "/tmp/proj", time: { updated: 200 } },
];

describe("newestSessionInDirectory", () => {
  it("takes the newest session IN the exact directory, ignoring newer siblings", () => {
    expect(newestSessionInDirectory(rows, "/tmp/proj")).toBe("ses_cap_new");
  });
  it("returns null when nothing matches", () => {
    expect(newestSessionInDirectory(rows, "/tmp/other")).toBeNull();
  });
});

describe("listSessions", () => {
  it("falls back from /session to /api/session", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (!url.endsWith("/api/session")) throw new Error("boom");
      return { ok: true, json: async () => rows } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await listSessions(1234, fetchImpl)).toEqual(rows);
    expect(calls).toEqual(["http://127.0.0.1:1234/session", "http://127.0.0.1:1234/api/session"]);
  });
  it("returns [] when the transport fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await listSessions(1234, fetchImpl)).toEqual([]);
  });
});
