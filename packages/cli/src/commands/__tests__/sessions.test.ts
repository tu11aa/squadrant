import { describe, it, expect } from "vitest";
import { filterSessions, formatSessionTable, type SessionRow } from "../sessions.js";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return { agent: "claude", id: "sess-1", pid: 1, cwd: "/a/b", status: "idle", ...over };
}

describe("filterSessions", () => {
  it("filters by agent", () => {
    const rows = [row({ agent: "claude" }), row({ agent: "opencode", id: "o" })];
    expect(filterSessions(rows, { agent: "opencode" }).map((r) => r.id)).toEqual(["o"]);
  });

  it("drops stale rows with --live-only", () => {
    const rows = [row({ status: "stale" }), row({ status: "idle", id: "live" })];
    expect(filterSessions(rows, { liveOnly: true }).map((r) => r.id)).toEqual(["live"]);
  });

  it("matches --project by the row's project field", () => {
    const rows = [row({ agent: "opencode", project: "squadrant" }), row({ agent: "opencode", project: "other" })];
    expect(filterSessions(rows, { project: "squadrant" }).map((r) => r.project)).toEqual(["squadrant"]);
  });

  it("matches --project by cwd under the registered project path", () => {
    const rows = [row({ cwd: "/a/b/sub" }), row({ cwd: "/elsewhere" })];
    const out = filterSessions(rows, { project: "p", projects: { p: "/a/b" } });
    expect(out.map((r) => r.cwd)).toEqual(["/a/b/sub"]);
  });

  it("returns all rows when no filter is set", () => {
    expect(filterSessions([row(), row({ id: "2" })], {})).toHaveLength(2);
  });
});

describe("formatSessionTable", () => {
  it("prints an explicit empty-state message, never throws (#792)", () => {
    expect(formatSessionTable([])).toMatch(/no .*sessions/i);
  });

  it("includes the agent, id, status and address of each row", () => {
    const out = formatSessionTable([
      row({ agent: "opencode", id: "ses_abc", status: "recorded", address: "http://127.0.0.1:1", cwd: "/p" }),
    ]);
    expect(out).toContain("opencode");
    expect(out).toContain("ses_abc");
    expect(out).toContain("recorded");
    expect(out).toContain("http://127.0.0.1:1");
  });

  it("renders missing pid/address as a dash rather than 'undefined'", () => {
    const out = formatSessionTable([row({ pid: undefined, address: undefined })]);
    expect(out).not.toContain("undefined");
    expect(out).toContain("-");
  });
});
