// #890: end-to-end through the real delivery loop — a recovered captain gets
// the coalesced current truth, not a chronological flood of stale events.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return { ...actual, loadConfig: loadConfigMock };
});

import { createDelivery, STUCK_ALERT_TEXT } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { readCursor, type MailboxEntry } from "../mailbox.js";

const project = "alpha";
const captainName = `${project}-captain`;

function setup(entries: MailboxEntry[], taskState: "done" | "review" = "done") {
  const stateRoot = mkdtempSync(join(tmpdir(), "deliv-coalesce-"));
  loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "🏛️ command" });
  const store = createStore(stateRoot);
  store.put({
    id: "t1", project, provider: "claude", mode: "interactive",
    state: taskState, task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
  });
  mkdirSync(join(stateRoot, "inbox"), { recursive: true });
  writeFileSync(join(stateRoot, "inbox", `${project}.log`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
  livenessRegistry.apply({
    project, role: "captain", pid: 123, sessionId: "s1",
    startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
    pidAlive: true, source: "runtime",
  });
  const sent: string[] = [];
  const cmux = {
    listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
    findWorkspaceId: async () => "w1",
    readScreen: async () => `${captainName}> `,
    send: async (_s: unknown, text: string) => { sent.push(text); },
  };
  const deliv = createDelivery({
    stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
  } as any, cmux as any);
  return { stateRoot, sent, deliv };
}

function ev(seq: number, kind: MailboxEntry["kind"], ageMs = 0): MailboxEntry {
  return { seq, ts: new Date(Date.now() - ageMs).toISOString(), taskId: "t1", kind, provider: "claude", message: `${kind} #${seq}` };
}

describe("delivery loop backlog coalescing (#890)", () => {
  it("replays quiet/idle/review ×N + done as just the done — never losing it — and acks the whole backlog", async () => {
    const backlog = [
      ev(1, "task.review"), ev(2, "task.turn.completed"), ev(3, "task.quiet"),
      ev(4, "task.review"), ev(5, "task.turn.completed"), ev(6, "task.quiet"),
      ev(7, "task.review"), ev(8, "task.done"),
    ];
    const { stateRoot, sent, deliv } = setup(backlog);
    await deliv.deliveryTick!();
    expect(sent).toEqual(["task.done #8"]);
    expect((await readCursor({ stateRoot, project, subscriber: "captain" }))?.lastAckedSeq).toBe(8);
  });

  it("prefixes an old replayed task event with the stale marker", async () => {
    const { sent, deliv } = setup([ev(1, "task.done", 8 * 60 * 60_000)]);
    await deliv.deliveryTick!();
    expect(sent).toEqual(["[stale — generated 8h ago] task.done #1"]);
  });

  it("drops a DELIVERY STUCK self-alert once delivery has succeeded, and still acks it", async () => {
    const stuck: MailboxEntry = {
      seq: 2, ts: new Date().toISOString(), kind: "captain.message",
      payload: { source: "daemon" }, message: STUCK_ALERT_TEXT["no-box"](300),
    };
    const { stateRoot, sent, deliv } = setup([ev(1, "task.review"), stuck], "review");
    await deliv.deliveryTick!();
    expect(sent).toEqual(["task.review #1"]);
    expect((await readCursor({ stateRoot, project, subscriber: "captain" }))?.lastAckedSeq).toBe(2);
  });
});
