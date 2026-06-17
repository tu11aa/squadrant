// Tests for the opencode SSE → ControlEvent bridge.
// The bridge subscribes to a crew's `opencode --port <N>` server at /event and
// maps the documented `session.idle` event to a cockpit `task.turn.completed`
// (which the reducer turns into awaiting-input). This closes the opencode idle
// gap: the daemon learns a turn ended without the crew shelling out to cockpit.
import { describe, it, expect, vi } from "vitest";
import { OpencodeSseBridge } from "../sse-bridge.js";
import type { ControlEvent } from "@cockpit/shared";

/** Build a Response whose body streams the given SSE text in one or more chunks. */
function sseResponse(chunks: string[], ok = true, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok, status, body } as unknown as Response;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("OpencodeSseBridge", () => {
  it("maps session.idle → task.turn.completed for the task", async () => {
    const events: ControlEvent[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"id":"e1","type":"server.connected"}\n',
        'data: {"id":"e2","type":"message.part.delta","properties":{}}\n',
        'data: {"id":"e3","type":"session.idle","properties":{"sessionID":"ses_x"}}\n',
      ]),
    );
    const bridge = new OpencodeSseBridge({ emit: (e) => events.push(e), fetchImpl });
    bridge.start({ taskId: "t1", port: 7777 });
    await flush();
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/event",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(events).toEqual([{ type: "task.turn.completed", id: "t1", turnId: "ses_x" }]);
  });

  it("emits once per session.idle across multiple turns", async () => {
    const events: ControlEvent[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"session.idle","properties":{"sessionID":"s"}}\n',
        'data: {"type":"message.updated"}\n',
        'data: {"type":"session.idle","properties":{"sessionID":"s"}}\n',
      ]),
    );
    const bridge = new OpencodeSseBridge({ emit: (e) => events.push(e), fetchImpl });
    bridge.start({ taskId: "t2", port: 7000 });
    await flush();
    await flush();
    expect(events.filter((e) => e.type === "task.turn.completed")).toHaveLength(2);
  });

  it("retries until the server binds (boot grace)", async () => {
    const events: ControlEvent[] = [];
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(
        sseResponse(['data: {"type":"session.idle","properties":{"sessionID":"s"}}\n']),
      );
    const bridge = new OpencodeSseBridge({
      emit: (e) => events.push(e),
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    bridge.start({ taskId: "t3", port: 6000 });
    for (let i = 0; i < 10; i++) await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: "task.turn.completed", id: "t3", turnId: "s" }]);
  });

  it("gives up after maxBootAttempts if the server never binds", async () => {
    const events: ControlEvent[] = [];
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const log = vi.fn();
    const bridge = new OpencodeSseBridge({
      emit: (e) => events.push(e),
      fetchImpl,
      sleep: () => Promise.resolve(),
      maxBootAttempts: 3,
      log,
    });
    bridge.start({ taskId: "t4", port: 5000 });
    for (let i = 0; i < 10; i++) await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  it("stop() aborts the subscription and ignores later data", async () => {
    const events: ControlEvent[] = [];
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Never resolves more data; the stream stays open until aborted.
        pulled++;
        if (pulled > 1) return new Promise(() => {});
        controller.enqueue(new TextEncoder().encode('data: {"type":"message.updated"}\n'));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);
    const bridge = new OpencodeSseBridge({ emit: (e) => events.push(e), fetchImpl });
    bridge.start({ taskId: "t5", port: 4000 });
    await flush();
    bridge.stop("t5");
    await flush();
    expect(events).toHaveLength(0);
  });

  it("start() is idempotent per task", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([]));
    const bridge = new OpencodeSseBridge({ emit: () => {}, fetchImpl });
    bridge.start({ taskId: "t6", port: 3000 });
    bridge.start({ taskId: "t6", port: 3000 });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // ── CP3: permission gate (live-verified opencode 1.15.13 shapes) ──────────
  // permission.asked carries properties = PermissionRequest:
  //   { id:"per_…", sessionID:"ses_…", permission:"bash", patterns:[…], … }
  // Reply endpoint (live-verified): POST /session/{sessionID}/permissions/{permissionID}
  //   body { response: "once"|"always"|"reject" } → 200, fires permission.replied.

  /** fetchImpl that streams the given SSE on GET /event and 200s any POST. */
  function permFetch(sse: string[]) {
    return vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith("/event")) return Promise.resolve(sseResponse(sse));
      return Promise.resolve({ ok: true, status: 200, body: null } as unknown as Response);
    });
  }

  it("maps permission.asked → task.approval.requested", async () => {
    const events: ControlEvent[] = [];
    const fetchImpl = permFetch([
      'data: {"id":"e1","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["echo hi"]}}\n',
    ]);
    const bridge = new OpencodeSseBridge({ emit: (e) => events.push(e), fetchImpl });
    bridge.start({ taskId: "t1", port: 7777 });
    await flush();
    await flush();
    const ev = events.find((e) => e.type === "task.approval.requested");
    expect(ev).toBeDefined();
    expect(ev).toMatchObject({ type: "task.approval.requested", id: "t1", kind: "bash" });
    // requestId is a synthetic number (opencode has no numeric request id on the
    // bus); it keys the daemon's gate promotion just like codex's JSON-RPC id.
    expect(typeof (ev as { requestId: number }).requestId).toBe("number");
    expect((ev as { question: string }).question).toContain("bash");
  });

  it("answer(approve) POSTs response 'once' to /session/{id}/permissions/{id}", async () => {
    const events: ControlEvent[] = [];
    const fetchImpl = permFetch([
      'data: {"type":"permission.asked","properties":{"id":"per_9","sessionID":"ses_9","permission":"bash","patterns":[]}}\n',
    ]);
    const bridge = new OpencodeSseBridge({ emit: (e) => events.push(e), fetchImpl });
    bridge.start({ taskId: "t1", port: 7777 });
    await flush();
    await flush();
    const resolved = await bridge.answer("t1", "approve");
    expect(resolved).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/session/ses_9/permissions/per_9",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ response: "once" }) }),
    );
  });

  it("answer(deny) POSTs response 'reject'", async () => {
    const fetchImpl = permFetch([
      'data: {"type":"permission.asked","properties":{"id":"per_7","sessionID":"ses_7","permission":"bash","patterns":[]}}\n',
    ]);
    const bridge = new OpencodeSseBridge({ emit: () => {}, fetchImpl });
    bridge.start({ taskId: "t1", port: 7777 });
    await flush();
    await flush();
    await bridge.answer("t1", "deny");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/session/ses_7/permissions/per_7",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ response: "reject" }) }),
    );
  });

  it("answer() returns false when no permission is pending", async () => {
    const fetchImpl = permFetch([]);
    const bridge = new OpencodeSseBridge({ emit: () => {}, fetchImpl });
    bridge.start({ taskId: "t1", port: 7777 });
    await flush();
    expect(await bridge.answer("t1", "approve")).toBe(false);
  });

  it("permission.replied clears the pending permission", async () => {
    const fetchImpl = permFetch([
      'data: {"type":"permission.asked","properties":{"id":"per_5","sessionID":"ses_5","permission":"bash","patterns":[]}}\n',
      'data: {"type":"permission.replied","properties":{"sessionID":"ses_5","requestID":"per_5","reply":"once"}}\n',
    ]);
    const bridge = new OpencodeSseBridge({ emit: () => {}, fetchImpl });
    bridge.start({ taskId: "t1", port: 7777 });
    await flush();
    await flush();
    // Already resolved on the bus → captain's later answer is a no-op.
    expect(await bridge.answer("t1", "approve")).toBe(false);
  });
});
