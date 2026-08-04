import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendCaptainSession,
  readCaptainSessionRegistry,
  selectGapSessions,
  CAPTAIN_SESSION_REGISTRY_FILE,
  SESSION_WINDOW_MS,
} from "../captain-session-registry.js";
import type { CaptainSessionRecord } from "../handoff-facts.js";

const NOW = Date.parse("2026-08-03T16:00:00.000Z");

function record(overrides: Partial<CaptainSessionRecord> = {}): CaptainSessionRecord {
  return {
    sessionId: "sess-1",
    project: "squadrant",
    agent: "claude",
    startedAt: "2026-08-01T00:00:00.000Z",
    cwd: "/repo",
    transcriptPath: "/repo/.claude/sess-1.jsonl",
    ...overrides,
  };
}

describe("appendCaptainSession / readCaptainSessionRegistry", () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-registry-"));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty list when no registry file exists yet", () => {
    expect(readCaptainSessionRegistry(vault)).toEqual([]);
  });

  it("appends a record and reads it back", () => {
    appendCaptainSession(vault, record());
    expect(readCaptainSessionRegistry(vault)).toEqual([record()]);
  });

  it("is append-only — multiple sessions accumulate, none overwritten", () => {
    appendCaptainSession(vault, record({ sessionId: "sess-1" }));
    appendCaptainSession(vault, record({ sessionId: "sess-2" }));
    appendCaptainSession(vault, record({ sessionId: "sess-3" }));

    const all = readCaptainSessionRegistry(vault);

    expect(all.map((r) => r.sessionId)).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  it("creates the spoke vault directory if it doesn't exist yet", () => {
    const nested = path.join(vault, "does", "not", "exist");
    appendCaptainSession(nested, record());
    expect(fs.existsSync(path.join(nested, CAPTAIN_SESSION_REGISTRY_FILE))).toBe(true);
  });

  it("skips a corrupt line instead of crashing", () => {
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(vault, CAPTAIN_SESSION_REGISTRY_FILE),
      "not json\n" + JSON.stringify(record({ sessionId: "sess-good" })) + "\n",
    );
    expect(readCaptainSessionRegistry(vault).map((r) => r.sessionId)).toEqual(["sess-good"]);
  });
});

// #651 correction: the gap is bounded by the CHECKPOINT (newest archived
// handoff), not a fixed recency window — a session already covered by the
// checkpoint should never be re-read. The window only applies as a fallback
// when there is no checkpoint at all (cold start, nothing ever archived).
describe("selectGapSessions", () => {
  it("excludes the current session by id — ground truth, not mtime", () => {
    const records = [record({ sessionId: "current" }), record({ sessionId: "prev" })];
    const { gapSessions } = selectGapSessions(records, "current", null, NOW);
    expect(gapSessions.map((r) => r.sessionId)).toEqual(["prev"]);
  });

  it("with a checkpoint, includes only sessions that started AFTER the checkpoint's timestamp", () => {
    const checkpointAgeMs = NOW - Date.parse("2026-08-02T00:00:00.000Z"); // checkpoint written 08-02
    const records = [
      record({ sessionId: "before", startedAt: "2026-08-01T00:00:00.000Z" }), // covered by checkpoint
      record({ sessionId: "after", startedAt: "2026-08-03T00:00:00.000Z" }), // NOT covered — the gap
    ];
    const { gapSessions, usedFallbackWindow } = selectGapSessions(records, "x", { ageMs: checkpointAgeMs }, NOW);
    expect(gapSessions.map((r) => r.sessionId)).toEqual(["after"]);
    expect(usedFallbackWindow).toBe(false);
  });

  it("with a checkpoint, does NOT bound the gap by SESSION_WINDOW_MS — an old checkpoint can still yield a wide gap", () => {
    const oldCheckpointAgeMs = NOW - Date.parse("2026-01-01T00:00:00.000Z"); // ancient checkpoint
    const records = [record({ sessionId: "well-outside-normal-window", startedAt: "2026-07-01T00:00:00.000Z" })];
    const { gapSessions } = selectGapSessions(records, "x", { ageMs: oldCheckpointAgeMs }, NOW);
    expect(gapSessions.map((r) => r.sessionId)).toEqual(["well-outside-normal-window"]);
  });

  it("without a checkpoint, widens to the bounded fallback window (default SESSION_WINDOW_MS)", () => {
    const justInside = new Date(NOW - SESSION_WINDOW_MS + 1000).toISOString();
    const justOutside = new Date(NOW - SESSION_WINDOW_MS - 1000).toISOString();
    const records = [
      record({ sessionId: "inside", startedAt: justInside }),
      record({ sessionId: "outside", startedAt: justOutside }),
    ];
    const { gapSessions, usedFallbackWindow } = selectGapSessions(records, "x", null, NOW);
    expect(gapSessions.map((r) => r.sessionId)).toEqual(["inside"]);
    expect(usedFallbackWindow).toBe(true);
  });

  it("fallback window is overridable per call", () => {
    const records = [record({ sessionId: "s", startedAt: new Date(NOW - 2 * 86_400_000).toISOString() })];
    expect(selectGapSessions(records, "x", null, NOW, 86_400_000).gapSessions).toEqual([]);
    expect(selectGapSessions(records, "x", null, NOW, 3 * 86_400_000).gapSessions.map((r) => r.sessionId)).toEqual(["s"]);
  });

  it("orders results newest-first", () => {
    const records = [
      record({ sessionId: "older", startedAt: new Date(NOW - 2 * 86_400_000).toISOString() }),
      record({ sessionId: "newer", startedAt: new Date(NOW - 1 * 86_400_000).toISOString() }),
    ];
    const { gapSessions } = selectGapSessions(records, "x", null, NOW);
    expect(gapSessions.map((r) => r.sessionId)).toEqual(["newer", "older"]);
  });

  it("never includes a non-captain session — the registry itself is captain-only by construction, nothing to filter here", () => {
    // The registry is written exclusively from the captain's own SessionStart
    // hook (see hooks.ts) — a plain/crew Claude session in the same project
    // never gets an entry, so selectGapSessions needs no role check at all.
    const records = [record({ sessionId: "only-captain-ever-appears" })];
    expect(selectGapSessions(records, "x", null, NOW).gapSessions.map((r) => r.sessionId)).toEqual([
      "only-captain-ever-appears",
    ]);
  });
});
