import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { handleCrewSignal } from "../crew-signal.js";
import { readCrewSentinels } from "../../lib/crew-sentinel.js";

const now = () => "2026-05-15T12:00:00.000Z";

describe("handleCrewSignal", () => {
  it("returns null and writes nothing when env identity is missing (no-op gate)", () => {
    const r = handleCrewSignal({ stdin: '{"hook_event_name":"Stop"}', now });
    expect(r).toBeNull();
  });

  it("writes a done sentinel for Stop", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-2",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Stop","session_id":"abc"}',
        now,
      });
      expect(r?.state).toBe("done");
      const got = readCrewSentinels(tmp, "oneplan");
      expect(got).toHaveLength(1);
      expect(got[0].crew).toBe("crew-2");
      expect(got[0].sessionId).toBe("abc");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes a blocked sentinel for Notification", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-1",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Notification"}',
        now,
      });
      expect(r?.state).toBe("blocked");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for unrelated events", () => {
    const r = handleCrewSignal({
      project: "p",
      crew: "c",
      stateDir: "/tmp",
      stdin: '{"hook_event_name":"PreToolUse"}',
      now,
    });
    expect(r).toBeNull();
  });

  it("tolerates non-JSON stdin", () => {
    const r = handleCrewSignal({
      project: "p",
      crew: "c",
      stateDir: "/tmp",
      stdin: "garbage",
      now,
    });
    expect(r).toBeNull();
  });
});
