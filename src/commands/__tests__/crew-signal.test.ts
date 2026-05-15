import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { handleCrewSignal } from "../crew-signal.js";
import { readCrewSentinels } from "../../lib/crew-sentinel.js";

const now = () => "2026-05-15T12:00:00.000Z";

describe("handleCrewSignal", () => {
  it("returns null and writes nothing when env identity is missing (no-op gate)", () => {
    const r = handleCrewSignal({
      stdin: '{"hook_event_name":"Notification","notification_type":"idle_prompt"}',
      now,
    });
    expect(r).toBeNull();
  });

  it("returns null for Stop (no sentinel — only idle Notification counts)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-2",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Stop","session_id":"abc"}',
        now,
      });
      expect(r).toBeNull();
      expect(readCrewSentinels(tmp, "oneplan")).toHaveLength(0);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for SubagentStop", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-2",
        stateDir: tmp,
        stdin: '{"hook_event_name":"SubagentStop"}',
        now,
      });
      expect(r).toBeNull();
      expect(readCrewSentinels(tmp, "oneplan")).toHaveLength(0);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes a done sentinel for an idle Notification (notification_type)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-2",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Notification","notification_type":"idle_prompt","session_id":"abc"}',
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

  it("writes a blocked sentinel for a permission Notification (notification_type)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-1",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Notification","notification_type":"permission_prompt"}',
        now,
      });
      expect(r?.state).toBe("blocked");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to message text → done when notification_type is absent (idle)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-1",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Notification","message":"Claude is waiting for your input"}',
        now,
      });
      expect(r?.state).toBe("done");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to message text → blocked when notification_type is absent (permission)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-1",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}',
        now,
      });
      expect(r?.state).toBe("blocked");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for a Notification with no recognizable type or message", () => {
    const r = handleCrewSignal({
      project: "p",
      crew: "c",
      stateDir: "/tmp",
      stdin: '{"hook_event_name":"Notification","notification_type":"some_future_kind"}',
      now,
    });
    expect(r).toBeNull();
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

  it("excerpt is the LAST assistant message, never the user prompt, surviving trailing non-assistant lines", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const transcript = path.join(tmp, "transcript.jsonl");
      await fsp.writeFile(
        transcript,
        [
          JSON.stringify({ type: "user", message: { content: "USER PROMPT do the thing" } }),
          JSON.stringify({ type: "assistant", message: { content: "the answer" } }),
          JSON.stringify({ type: "attachment", path: "/x" }),
          JSON.stringify({ type: "system", subtype: "info" }),
        ].join("\n"),
      );
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-2",
        stateDir: tmp,
        stdin: JSON.stringify({
          hook_event_name: "Notification",
          notification_type: "idle_prompt",
          transcript_path: transcript,
        }),
        now,
      });
      expect(r?.excerpt).toBe("the answer");
      expect(r?.excerpt).not.toContain("USER PROMPT");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
