import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  writeCrewSentinel,
  readCrewSentinels,
  alreadyNudged,
  markNudged,
  type CrewSentinel,
} from "../crew-sentinel.js";

function sentinel(over: Partial<CrewSentinel> = {}): CrewSentinel {
  return {
    project: "oneplan",
    crew: "crew-1",
    state: "done",
    event: "Stop",
    ts: "2026-05-15T10:00:00.000Z",
    excerpt: "finished the task",
    ...over,
  };
}

describe("crew-sentinel", () => {
  it("round-trips a sentinel through write/read", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-sent-"));
    try {
      writeCrewSentinel(tmp, sentinel());
      const got = readCrewSentinels(tmp, "oneplan");
      expect(got).toHaveLength(1);
      expect(got[0].crew).toBe("crew-1");
      expect(got[0].state).toBe("done");
      expect(got[0].excerpt).toBe("finished the task");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns [] when the project dir does not exist", () => {
    expect(readCrewSentinels("/no/such/dir", "x")).toEqual([]);
  });

  it("skips corrupt sentinel files", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-sent-"));
    try {
      writeCrewSentinel(tmp, sentinel());
      await fsp.writeFile(path.join(tmp, "oneplan", "broken.json"), "{not json");
      const got = readCrewSentinels(tmp, "oneplan");
      expect(got).toHaveLength(1);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("tracks nudge markers per sentinel ts", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-sent-"));
    try {
      const s = sentinel();
      expect(alreadyNudged(tmp, s)).toBe(false);
      markNudged(tmp, s);
      expect(alreadyNudged(tmp, s)).toBe(true);
      expect(alreadyNudged(tmp, { ...s, ts: "2026-05-15T11:00:00.000Z" })).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
