import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newestSessionInDirectory, listSessions, resolveAndPersistOpencodeCaptain,
  parseLiveOpencodeServers, discoverLiveOpencodeServer,
} from "../opencode-session.js";
import { readCaptainAddress } from "../captain-record.js";

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

  // #789: a cold start has NO session of its own until the startup prompt creates
  // one. A pre-existing session in the same directory — newer by `updated` because
  // the developer used it more recently — must never win.
  it("ignores sessions created before `createdAfterMs` even when they are newer by `updated`", () => {
    const launchedMs = 1_000_000;
    const withCreated = [
      { id: "ses_stale", directory: "/tmp/proj", time: { created: launchedMs - 3_600_000, updated: launchedMs + 10_000 } },
      { id: "ses_captain", directory: "/tmp/proj", time: { created: launchedMs + 4_000, updated: launchedMs + 5_000 } },
    ];
    expect(newestSessionInDirectory(withCreated, "/tmp/proj", launchedMs)).toBe("ses_captain");
  });
  it("returns null when every matching session predates `createdAfterMs`", () => {
    const launchedMs = 1_000_000;
    const staleOnly = [
      { id: "ses_stale", directory: "/tmp/proj", time: { created: launchedMs - 1, updated: launchedMs + 10_000 } },
    ];
    expect(newestSessionInDirectory(staleOnly, "/tmp/proj", launchedMs)).toBeNull();
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

// #789 regression: the resolver must persist ONLY the session the captain itself
// created (created at/after `launchedAt`), and on timeout it must write NOTHING —
// an absent record reads downstream as the honest `no-channel` alert, whereas a
// pre-existing session is a silent misroute.
describe("resolveAndPersistOpencodeCaptain (#789)", () => {
  const launchedAt = "2026-09-17T15:22:28.794Z";
  const launchedMs = Date.parse(launchedAt);
  const fetchRows = (r: unknown[]) =>
    (async () => ({ ok: true, json: async () => r })) as unknown as typeof fetch;

  it("persists the captain's own session and the caller's launchedAt", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "sq-789-"));
    const id = await resolveAndPersistOpencodeCaptain({
      stateRoot, project: "proj", port: 1234, directory: "/tmp/proj", launchedAt,
      timeoutMs: 0, sleep: async () => {}, fetchImpl: fetchRows([
        { id: "ses_stale", directory: "/tmp/proj", time: { created: launchedMs - 3_600_000, updated: launchedMs + 10_000 } },
        { id: "ses_captain", directory: "/tmp/proj", time: { created: launchedMs + 4_000, updated: launchedMs + 5_000 } },
      ]),
    });
    expect(id).toBe("ses_captain");
    expect(readCaptainAddress(stateRoot, "proj")).toMatchObject({
      agent: "opencode", port: 1234, sessionId: "ses_captain", directory: "/tmp/proj", launchedAt,
    });
  });

  it("writes NO record when only stale sessions exist (timeout ⇒ not deliverable)", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "sq-789-"));
    const id = await resolveAndPersistOpencodeCaptain({
      stateRoot, project: "proj", port: 1234, directory: "/tmp/proj", launchedAt,
      timeoutMs: 0, sleep: async () => {}, fetchImpl: fetchRows([
        { id: "ses_stale", directory: "/tmp/proj", time: { created: launchedMs - 1, updated: launchedMs + 10_000 } },
      ]),
    });
    expect(id).toBeNull();
    expect(readCaptainAddress(stateRoot, "proj")).toBeNull();
  });

  // #797 issue 4: a RESUME reuses the prior record's session id, so there is
  // nothing to resolve — and the #789 created-after gate must NOT reject it (a
  // resumed session necessarily predates `launchedAt`, which is why a stale
  // port previously survived every relaunch).
  it("persists the caller's known session id immediately on resume — no created-after gate", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "sq-797-"));
    const id = await resolveAndPersistOpencodeCaptain({
      stateRoot, project: "proj", port: 61099, directory: "/tmp/proj", launchedAt,
      sessionId: "ses_resumed",
      // Would return the stale session if the poll ran — proving the known id
      // path short-circuits before resolution.
      timeoutMs: 0, sleep: async () => {}, fetchImpl: fetchRows([
        { id: "ses_stale", directory: "/tmp/proj", time: { created: launchedMs - 3_600_000, updated: launchedMs + 99_999 } },
      ]),
    });
    expect(id).toBe("ses_resumed");
    expect(readCaptainAddress(stateRoot, "proj")).toMatchObject({
      agent: "opencode", port: 61099, sessionId: "ses_resumed", directory: "/tmp/proj", launchedAt,
    });
  });
});

// #797 issue 1: when the recorded port is dead, the self-heal must find the
// captain's live server — matching by its own session id first, then by the
// project directory — instead of dialing the dead port forever.
describe("parseLiveOpencodeServers / discoverLiveOpencodeServer (#797)", () => {
  const PS = [
    "  101 opencode --port 49526",
    "  202 opencode --session ses_cap --port 61099",
    "  303 opencode --port=63122",
    "  404 node /usr/local/bin/opencode --port 64000",
    "  505 vim --port 12345",
    "  606 opencode",
    "  707 opencode run \"not a server\"",
  ].join("\n");

  it("keeps only opencode server lines that carry --port, with or without --session", () => {
    expect(parseLiveOpencodeServers(PS)).toEqual([
      { pid: 101, port: 49526 },
      { pid: 202, port: 61099, sessionId: "ses_cap" },
      { pid: 303, port: 63122 },
    ]);
  });

  it("matches by the record's session id first, regardless of directory", () => {
    const live = discoverLiveOpencodeServer({
      directory: "/tmp/nope",
      sessionId: "ses_cap",
      psOutput: () => PS,
      cwdOf: () => null,
    });
    expect(live).toEqual({ pid: 202, port: 61099, sessionId: "ses_cap" });
  });

  it("falls back to matching the process cwd against the record directory", () => {
    const live = discoverLiveOpencodeServer({
      directory: "/tmp/proj",
      psOutput: () => PS,
      cwdOf: (pid) => (pid === 101 ? "/tmp/proj" : "/tmp/other"),
    });
    expect(live).toEqual({ pid: 101, port: 49526 });
  });

  it("returns null when nothing matches", () => {
    expect(discoverLiveOpencodeServer({
      directory: "/tmp/proj", psOutput: () => PS, cwdOf: () => "/tmp/other",
    })).toBeNull();
  });
});
