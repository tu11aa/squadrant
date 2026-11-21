import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeFreshness, findHandoff, archiveLiveHandoff, describeSession, toSessionToRead, HANDOFF_GRACE_MS,
} from "../handoff-read.js";
import type { SessionActivity } from "../handoff-read.js";

// Local-time constructors keep the day math independent of the machine TZ.
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 21, 15); // Sat 15:00
const WINDOW = 7 * 86_400_000;

const session = (id: string, lastActivityMs: number, startedMs = lastActivityMs - 3_600_000): SessionActivity => ({
  record: { sessionId: id, project: "p", agent: "claude", startedAt: new Date(startedMs).toISOString(), cwd: "/x", transcriptPath: `/t/${id}.jsonl` },
  lastActivityMs,
  activeDays: ["2026-11-20"],
  wroteHandoff: false,
});

describe("computeFreshness", () => {
  it("yesterday's live handoff, no later session → fresh, no warning", () => {
    const v = computeFreshness({ source: "live", writtenAtMs: at(2026, 11, 20, 18) }, [session("old", at(2026, 11, 20, 17))], NOW, WINDOW);
    expect(v).toMatchObject({ fresh: true, ageDays: 1, warning: null, sessionsToRead: [] });
  });

  it("handoff older than yesterday → stale with an old-handoff warning", () => {
    const v = computeFreshness({ source: "live", writtenAtMs: at(2026, 11, 16, 18) }, [], NOW, WINDOW);
    expect(v.fresh).toBe(false);
    expect(v.ageDays).toBe(5);
    expect(v.warning).toContain("old handoff from 2026-11-16");
  });

  it("fresh-dated handoff but another session was active after it → stale, session listed", () => {
    const v = computeFreshness({ source: "live", writtenAtMs: at(2026, 11, 20, 18) }, [session("wed", at(2026, 11, 21, 9))], NOW, WINDOW);
    expect(v.fresh).toBe(false);
    expect(v.sessionsToRead.map((s) => s.record.sessionId)).toEqual(["wed"]);
  });

  it("long-lived session started before the handoff but active after it is caught (activity, not startedAt)", () => {
    const longLived = session("long", at(2026, 11, 21, 10), at(2026, 11, 17, 9));
    const v = computeFreshness({ source: "live", writtenAtMs: at(2026, 11, 18, 18) }, [longLived], NOW, WINDOW);
    expect(v.fresh).toBe(false);
    expect(v.sessionsToRead).toHaveLength(1);
  });

  it("the closing turn of the session that wrote the handoff (within grace) is not later work", () => {
    const w = at(2026, 11, 20, 18);
    const v = computeFreshness({ source: "live", writtenAtMs: w }, [session("writer", w + HANDOFF_GRACE_MS - 1000)], NOW, WINDOW);
    expect(v.fresh).toBe(true);
  });

  it("an archived handoff that is recent and has no later session is still fresh (repeat read after archiving)", () => {
    const v = computeFreshness({ source: "archive", writtenAtMs: at(2026, 11, 21, 8) }, [], NOW, WINDOW);
    expect(v.fresh).toBe(true);
  });

  it("old archive with no live file → stale, warning says it is the archived one, sessions after it listed newest first", () => {
    const v = computeFreshness(
      { source: "archive", writtenAtMs: at(2026, 10, 10) },
      [session("a", at(2026, 11, 1)), session("b", at(2026, 11, 14))],
      NOW,
      WINDOW,
    );
    expect(v.fresh).toBe(false);
    expect(v.warning).toContain("no live handoff.json");
    expect(v.sessionsToRead.map((s) => s.record.sessionId)).toEqual(["b", "a"]);
  });

  it("no handoff at all → stale; only sessions inside the window are listed", () => {
    const v = computeFreshness(null, [session("in", at(2026, 11, 19)), session("out", at(2026, 10, 1))], NOW, WINDOW);
    expect(v.fresh).toBe(false);
    expect(v.ageDays).toBeNull();
    expect(v.sessionsToRead.map((s) => s.record.sessionId)).toEqual(["in"]);
  });
});

describe("toSessionToRead", () => {
  it("reports 'no end recorded' when the session has no endedAt, else the recorded time", () => {
    const s = session("x", at(2026, 11, 20, 17));
    expect(toSessionToRead(s).endedAt).toMatch(/^no end recorded \(last activity /);
    const ended = { ...s, record: { ...s.record, endedAt: "2026-11-20T18:00:00.000Z" } };
    expect(toSessionToRead(ended).endedAt).toBe("2026-11-20T18:00:00.000Z");
    expect(toSessionToRead(s)).toMatchObject({ name: "claude-captain-p", sessionId: "x", transcriptPath: "/t/x.jsonl", wroteHandoff: false });
  });
});

describe("handoff files", () => {
  let tmp: string;
  let ws: string;
  let legacy: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-read-"));
    ws = path.join(tmp, "ws", "p");
    legacy = path.join(tmp, "hub", "p");
    fs.mkdirSync(path.join(ws, "handoffs"), { recursive: true });
    fs.mkdirSync(path.join(legacy, "handoffs"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const put = (file: string, writtenAt: string) => fs.writeFileSync(file, JSON.stringify({ written_at: writtenAt, tag: path.basename(file) }));

  it("prefers the live file over any archive", () => {
    put(path.join(ws, "handoff.json"), "2026-11-01T00:00:00Z");
    put(path.join(ws, "handoffs", "2026-11-20.json"), "2026-11-20T00:00:00Z");
    expect(findHandoff([ws, legacy])).toMatchObject({ source: "live", path: path.join(ws, "handoff.json") });
  });

  it("with no live file, returns the newest archive across workspace and legacy dirs (by written_at)", () => {
    put(path.join(ws, "handoffs", "2026-10-10.json"), "2026-10-10T00:00:00Z");
    put(path.join(legacy, "handoffs", "2026-11-05.json"), "2026-11-05T00:00:00Z");
    expect(findHandoff([ws, legacy])).toMatchObject({ source: "archive", path: path.join(legacy, "handoffs", "2026-11-05.json") });
  });

  it("falls back to a legacy live handoff and skips a corrupt file", () => {
    fs.writeFileSync(path.join(ws, "handoff.json"), "{not json");
    put(path.join(legacy, "handoff.json"), "2026-11-20T00:00:00Z");
    expect(findHandoff([ws, legacy])).toMatchObject({ source: "live", path: path.join(legacy, "handoff.json") });
  });

  it("returns null when nothing exists", () => {
    expect(findHandoff([ws, legacy])).toBeNull();
  });

  it("archives the live file without clobbering a same-day archive", () => {
    const now = new Date("2026-11-21T10:00:00Z");
    put(path.join(ws, "handoff.json"), "a");
    const first = archiveLiveHandoff(ws, path.join(ws, "handoff.json"), now);
    put(path.join(ws, "handoff.json"), "b");
    const second = archiveLiveHandoff(ws, path.join(ws, "handoff.json"), now);
    expect(path.basename(first)).toBe("2026-11-21.json");
    expect(path.basename(second)).toBe("2026-11-21-2.json");
    expect(fs.existsSync(path.join(ws, "handoff.json"))).toBe(false);
  });

  it("describeSession reads last activity, active days and the handoff-written flag from the transcript", () => {
    const t = path.join(tmp, "t.jsonl");
    fs.writeFileSync(
      t,
      [
        JSON.stringify({ timestamp: "2026-11-17T09:00:00.000Z", type: "user" }),
        JSON.stringify({ timestamp: "2026-11-18T09:00:00.000Z", type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "~/.config/squadrant/scripts/write-handoff.sh p '{}'" } }] } }),
        JSON.stringify({ type: "custom-title", customTitle: "squadrant-captain-p", sessionId: "s" }),
      ].join("\n"),
    );
    const mtime = new Date("2026-11-19T12:00:00Z");
    fs.utimesSync(t, mtime, mtime);
    const s = describeSession({ sessionId: "s", project: "p", agent: "claude", startedAt: "2026-11-17T08:00:00.000Z", cwd: "/x", transcriptPath: t });
    expect(s.lastActivityMs).toBe(mtime.getTime());
    expect(s.activeDays.length).toBeGreaterThanOrEqual(3);
    expect(s.wroteHandoff).toBe(true);
    expect(toSessionToRead(s).name).toBe("squadrant-captain-p");
  });

  it("wroteHandoff is false when write-handoff.sh only appears in loaded skill text or a non-Bash tool (no false positive)", () => {
    const t = path.join(tmp, "skill.jsonl");
    fs.writeFileSync(
      t,
      [
        JSON.stringify({ type: "user", message: { content: "skill: run ~/.config/squadrant/scripts/write-handoff.sh {project}" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "write-handoff.sh" } }] } }),
      ].join("\n"),
    );
    const s = describeSession({ sessionId: "s", project: "p", agent: "claude", startedAt: "2026-11-17T08:00:00.000Z", cwd: "/x", transcriptPath: t });
    expect(s.wroteHandoff).toBe(false);
  });

  it("a missing transcript is flagged transcriptMissing and named in the stale warning", () => {
    const gone = describeSession({ sessionId: "g", project: "p", agent: "claude", startedAt: new Date(at(2026, 11, 21, 9)).toISOString(), cwd: "/x", transcriptPath: "/nope" });
    expect(gone.transcriptMissing).toBe(true);
    expect(toSessionToRead(gone)).toMatchObject({ transcriptMissing: true, name: "claude-captain-p" });
    const v = computeFreshness({ source: "live", writtenAtMs: at(2026, 11, 20, 18) }, [gone], NOW, WINDOW);
    expect(v.fresh).toBe(false);
    expect(v.warning).toContain("transcriptMissing: true");
    const none = computeFreshness(null, [gone], NOW, WINDOW);
    expect(none.warning).toContain("transcriptMissing: true");
  });

  it("registry folds SessionEnd markers onto start records; an end before later activity is ignored", async () => {
    const { appendCaptainSession, appendCaptainSessionEnd, readCaptainSessionRegistry } = await import("../captain-session-registry.js");
    const rec = { sessionId: "s1", project: "p", agent: "claude", startedAt: "2026-11-20T08:00:00.000Z", cwd: "/x", transcriptPath: "/t" };
    appendCaptainSession(ws, rec);
    appendCaptainSessionEnd(ws, "s1", "2026-11-20T10:00:00.000Z");
    const [r] = readCaptainSessionRegistry(ws);
    expect(r.endedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(readCaptainSessionRegistry(ws)).toHaveLength(1);
    const act = (lastMs: number): SessionActivity => ({ record: r, lastActivityMs: lastMs, activeDays: [], wroteHandoff: false });
    expect(toSessionToRead(act(Date.parse("2026-11-20T10:00:00.000Z"))).endedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(toSessionToRead(act(Date.parse("2026-11-21T10:00:00.000Z"))).endedAt).toMatch(/^no end recorded/);
  });

  it("describeSession falls back to startedAt when the transcript is missing", () => {
    const s = describeSession({ sessionId: "s", project: "p", agent: "claude", startedAt: "2026-11-17T08:00:00.000Z", cwd: "/x", transcriptPath: "/nope" });
    expect(s.lastActivityMs).toBe(Date.parse("2026-11-17T08:00:00.000Z"));
    expect(s.wroteHandoff).toBe(false);
  });
});
