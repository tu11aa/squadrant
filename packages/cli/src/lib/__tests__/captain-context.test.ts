import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const records = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("@squadrant/shared", async (orig) => ({
  ...(await orig<typeof import("@squadrant/shared")>()),
  loadConfig: () => ({ projects: {} }),
  workspacePath: () => "/ws",
}));
vi.mock("../captain-session-registry.js", () => ({
  readCaptainSessionRegistry: () => records.list,
}));

import { captainTranscriptPath } from "../captain-context.js";

describe("captainTranscriptPath (#1023)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "capctx-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("skips a newest record whose transcript is missing and uses the older valid one", () => {
    const valid = path.join(dir, "live.jsonl");
    fs.writeFileSync(valid, "");
    const rec = (id: string, startedAt: string, transcriptPath: string) => ({
      sessionId: id, project: "p", agent: "claude", startedAt, cwd: dir, transcriptPath,
    });
    records.list = [
      rec("old", "2026-10-21T01:00:00Z", valid),
      rec("bogus", "2026-10-21T02:00:00Z", path.join(dir, "missing.jsonl")),
    ];
    expect(captainTranscriptPath("p")).toBe(valid);
  });

  it("returns null when no record has a transcript", () => {
    records.list = [];
    expect(captainTranscriptPath("p")).toBeNull();
  });
});
