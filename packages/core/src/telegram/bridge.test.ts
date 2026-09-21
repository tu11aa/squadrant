import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelegramBridge, type TelegramBridgeOptions } from "./bridge.js";
import { setTopic } from "./state.js";
import type { TelegramConfig } from "@squadrant/shared";
import type { Update } from "@grammyjs/types";

// Drive the real poll loop with one batch of updates, resolving once the batch is
// fully drained (the loop asks for a 2nd batch). Returns the bridge so the caller
// can stop it. The 2nd getUpdates hangs so the loop parks instead of busy-looping.
function drive(opts: Omit<TelegramBridgeOptions, "client">, updates: Array<Partial<Update>>) {
  let served = false;
  let resolveDrained!: () => void;
  const drained = new Promise<void>((r) => { resolveDrained = r; });
  const client = {
    getUpdates: vi.fn(async () => {
      if (!served) { served = true; return updates as Update[]; }
      resolveDrained();
      return new Promise<Update[]>(() => {}); // park
    }),
    sendMessage: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => 999),
    getMe: vi.fn(async () => ({ id: 1, username: "bot" })),
    setMyCommands: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageReplyMarkup: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
    setMessageReaction: vi.fn(async () => {}),
  };
  const bridge = createTelegramBridge({ ...opts, client });
  bridge.start();
  return { bridge, client, drained };
}

const CHAT = -100;
const ALLOWED_USER = 42;
const baseCfg: TelegramConfig = { supergroupId: CHAT, chats: [CHAT], pollMs: 5 };

function generalMsg(text: string, fromId = ALLOWED_USER): Partial<Update> {
  return { update_id: 1, message: { chat: { id: CHAT }, text, from: { id: fromId } } as any };
}
function topicMsg(text: string, threadId: number, fromId = ALLOWED_USER): Partial<Update> {
  return { update_id: 1, message: { chat: { id: CHAT }, message_thread_id: threadId, text, from: { id: fromId } } as any };
}
/** Same, but carrying a message_id — stage-1's reaction needs one. */
function topicMsgWithId(text: string, threadId: number, messageId: number, fromId = ALLOWED_USER): Partial<Update> {
  return { update_id: 1, message: { chat: { id: CHAT }, message_thread_id: threadId, message_id: messageId, text, from: { id: fromId } } as any };
}

/** A project-topic message carrying media (#768). Telegram puts the operator's
 *  typed text in `caption`, not `text`, for these. */
function mediaMsg(threadId: number, media: Record<string, unknown>, caption?: string, fromId = ALLOWED_USER): Partial<Update> {
  return {
    update_id: 1,
    message: {
      chat: { id: CHAT },
      message_thread_id: threadId,
      message_id: 556,
      ...(caption === undefined ? {} : { caption }),
      ...media,
      from: { id: fromId },
    } as any,
  };
}

let stateRoot: string;
beforeEach(() => { stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bridge-")); });
afterEach(() => { fs.rmSync(stateRoot, { recursive: true, force: true }); });

function deps(over: Partial<TelegramBridgeOptions> = {}) {
  return {
    stateRoot,
    appendCaptainMessage: vi.fn(async () => {}),
    log: vi.fn(),
    ensureCaptainAlive: vi.fn(async () => "alive" as const),
    runCommand: vi.fn(async () => "output"),
    sendReply: vi.fn(async () => {}),
    // #838/#839: the bridge drives the lifecycle; tests assert on begin().
    lifecycle: { begin: vi.fn(), start: vi.fn(), stop: vi.fn(), pending: vi.fn(() => ({})) },
    ...over,
  };
}

describe("handleUpdate routing", () => {
  it("replies with a hint to freeform text in the General topic", async () => {
    const d = deps();
    const { bridge, drained } = drive({ cfg: baseCfg, ...d }, [generalMsg("hello there")]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(undefined, expect.stringContaining("/help"));
    expect(d.runCommand).not.toHaveBeenCalled();
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("rejects a General command when remoteControl is off", async () => {
    const d = deps();
    const { bridge, drained } = drive({ cfg: baseCfg, ...d }, [generalMsg("/status")]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(undefined, expect.stringContaining("not authorized"));
    expect(d.runCommand).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("runs a General command when control is on and sender is authorized", async () => {
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps();
    const { bridge, drained } = drive({ cfg, ...d }, [generalMsg("/status")]);
    await drained;
    expect(d.runCommand).toHaveBeenCalledWith(["status"]);
    expect(d.sendReply).toHaveBeenCalledWith(undefined, "output");
    bridge.stop();
  });

  it("rejects a General command from a non-allowlisted user even when control is on", async () => {
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps();
    const { bridge, drained } = drive({ cfg, ...d }, [generalMsg("/status", 9999)]);
    await drained;
    expect(d.runCommand).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledWith(undefined, expect.stringContaining("not authorized"));
    bridge.stop();
  });

  it("auto-launches then delivers in a project topic when control is on + authorized", async () => {
    setTopic(stateRoot, "brove", 7);
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps({ ensureCaptainAlive: vi.fn(async () => "launched" as const) });
    const { bridge, drained } = drive({ cfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(d.ensureCaptainAlive).toHaveBeenCalledWith("brove");
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ project: "brove", source: "telegram" }),
    );
    // #517 follow-up: "launched" is a live-captain-reachable success, same as "alive".
    expect(d.sendReply).toHaveBeenCalledWith(7, "📨 delivered to brove captain");
    bridge.stop();
  });

  it("acks delivery when the captain was already alive (no boot needed)", async () => {
    setTopic(stateRoot, "brove", 7);
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps({ ensureCaptainAlive: vi.fn(async () => "alive" as const) });
    const { bridge, drained } = drive({ cfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(7, "📨 delivered to brove captain");
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ project: "brove", source: "telegram" }),
    );
    bridge.stop();
  });

  it("delivers without auto-launch in a project topic when control is off (v1 parity)", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: baseCfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(d.ensureCaptainAlive).not.toHaveBeenCalled();
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ project: "brove", source: "telegram" }),
    );
    bridge.stop();
  });

  it("sends an explicit failure into the topic when warmup times out but still queues the message", async () => {
    setTopic(stateRoot, "brove", 7);
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps({ ensureCaptainAlive: vi.fn(async () => "timeout" as const) });
    const { bridge, drained } = drive({ cfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(
      7,
      "❌ couldn't reach brove captain — saved to mailbox, will deliver when you open the workspace.",
    );
    expect(d.appendCaptainMessage).toHaveBeenCalled();
    bridge.stop();
  });

  it("#834: no 'not reachable' receipt when a gone channel falls back and delivers", async () => {
    setTopic(stateRoot, "brove", 7);
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    // The channel reports the (transient) fast-fail `gone`; the bridge's mailbox
    // fallback below is what actually delivers. The operator must not be told the
    // message failed — the fallback IS the final verdict.
    const d = deps({ deliverInbound: vi.fn(async () => ({ handled: false, outcome: { status: "gone" as const } })) });
    const { bridge, drained } = drive({ cfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    const receipts = vi.mocked(d.sendReply).mock.calls.map((c) => c[1]);
    expect(receipts.some((t: string) => t.includes("not reachable"))).toBe(false);
    // The fallback queued the message exactly once (no duplicate mailbox copy).
    expect(d.appendCaptainMessage).toHaveBeenCalledTimes(1);
    bridge.stop();
  });

  it("#834: a transient/unknown health state does not yield an 'unreachable' receipt", async () => {
    setTopic(stateRoot, "brove", 7);
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps({ ensureCaptainAlive: vi.fn(async () => "unknown" as const) });
    const { bridge, drained } = drive({ cfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    const receipts = vi.mocked(d.sendReply).mock.calls.map((c) => c[1]);
    expect(receipts.some((t: string) => t.includes("not reachable") || t.includes("couldn't reach"))).toBe(false);
    bridge.stop();
  });

  it("drops messages from non-allowlisted chats", async () => {
    const d = deps();
    const msg = { update_id: 1, message: { chat: { id: -999 }, text: "/status", from: { id: ALLOWED_USER } } as any };
    const { bridge, drained } = drive({ cfg: baseCfg, ...d }, [msg]);
    await drained;
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(d.runCommand).not.toHaveBeenCalled();
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });
});

describe("inbound media (#768)", () => {
  const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };

  it("forwards a captioned photo as the caption plus a not-forwarded marker", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [mediaMsg(7, { photo: [{ file_id: "f1" }] }, "look at this")]);
    await drained;
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "brove",
        source: "telegram",
        text: expect.stringContaining("look at this\n[photo attached - not forwarded]"),
      }),
    );
    bridge.stop();
  });

  it("tells the operator the photo itself was not delivered", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [mediaMsg(7, { photo: [{ file_id: "f1" }] }, "look at this")]);
    await drained;
    const bodies = (d.sendReply as any).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies).toContain("📎 photo not forwarded — your caption reached the captain");
    bridge.stop();
  });

  it("still forwards a marker-only captain message for a photo with no caption", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [mediaMsg(7, { photo: [{ file_id: "f1" }] })]);
    await drained;
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("[photo attached - not forwarded]") }),
    );
    const bodies = (d.sendReply as any).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies).toContain("📎 photo not forwarded — the captain was told it arrived, nothing else was sent");
    bridge.stop();
  });

  it("names the actual attachment rather than assuming a photo", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [mediaMsg(7, { document: { file_id: "d1" } }, "the spec")]);
    await drained;
    const bodies = (d.sendReply as any).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies).toContain("📎 document not forwarded — your caption reached the captain");
    bridge.stop();
  });

  it("does not swallow a voice note with no caption", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [mediaMsg(7, { voice: { file_id: "v1" } })]);
    await drained;
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("[voice message attached - not forwarded]") }),
    );
    bridge.stop();
  });

  it("still drops a service message that has neither text nor media", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const msg = { update_id: 1, message: { chat: { id: CHAT }, message_thread_id: 7, new_chat_member: {} } as any };
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [msg]);
    await drained;
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    expect(d.sendReply).not.toHaveBeenCalled();
    bridge.stop();
  });
});

describe("/notify in a project topic", () => {
  const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };

  it("bare /notify (authorized) replies with the panel and never appends a captain message", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/notify", 7)]);
    await drained;
    // tap-first: the panel ships as the 3rd (replyMarkup) arg with an inline keyboard.
    expect(d.sendReply).toHaveBeenCalledWith(7, expect.stringContaining("brove"), expect.objectContaining({ inline_keyboard: expect.anything() }));
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("bare /notify@botname (authorized) replies with the panel (proves @botname strip)", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/notify@squadrant_bot", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(7, expect.stringContaining("brove"), expect.objectContaining({ inline_keyboard: expect.anything() }));
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("bare /notify (unauthorized) replies not authorized and never appends", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: baseCfg, ...d }, [topicMsg("/notify", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(7, expect.stringContaining("not authorized"));
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("/notify cap on (authorized) applies the preference and never appends", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/notify cap on", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(7, expect.stringContaining("cap = on"));
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("a normal message is still appended as a captain message", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(d.appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ project: "brove", source: "telegram" }),
    );
    bridge.stop();
  });
});

describe("two-stage ACK + typing lifecycle (#838)", () => {
  const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };

  it("stage 1 reacts on the inbound message and sends no extra message for it", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("ship it", 7, 555)]);
    await drained;
    expect(client.setMessageReaction).toHaveBeenCalledWith(CHAT, 555, "👍");
    bridge.stop();
  });

  it("stage 2 sends exactly one `captain received` text and starts the typing lifecycle", async () => {
    setTopic(stateRoot, "brove", 7);
    const begin = vi.fn();
    const d = deps({ lifecycle: { begin } } as any);
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("ship it", 7, 555)]);
    await drained;
    expect(begin).toHaveBeenCalledWith("brove", 7);
    // The one stage-2 text, plus the auto-launch "delivered" line — never the
    // old per-message flood. Count only the stage-2 body here.
    const bodies = (d.sendReply as any).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies.filter((t: string) => t === "✅ captain received")).toHaveLength(1);
    bridge.stop();
  });

  it("no longer fires the old single-shot sendChatAction from the bridge", async () => {
    // The typing action is now owned by the lifecycle (keep-alive), so a bare
    // fire-and-forget call here would double-drive it.
    setTopic(stateRoot, "brove", 7);
    const begin = vi.fn();
    const d = deps({ lifecycle: { begin } } as any);
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("ship it", 7, 555)]);
    await drained;
    expect(client.sendChatAction).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("swallows a rejected reaction — a client that cannot react must not fail delivery", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("ship it", 7, 555)]);
    (client.setMessageReaction as any).mockRejectedValue(new Error("reaction not supported"));
    await drained;
    expect(d.appendCaptainMessage).toHaveBeenCalled();
    bridge.stop();
  });

  it("omits the reaction when the update carries no message_id", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(client.setMessageReaction).not.toHaveBeenCalled();
    expect(d.appendCaptainMessage).toHaveBeenCalled();
    bridge.stop();
  });

  it("does not react or start a lifecycle for a command message", async () => {
    setTopic(stateRoot, "brove", 7);
    const begin = vi.fn();
    const d = deps({ lifecycle: { begin } } as any);
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("/status", 7, 555)]);
    await drained;
    expect(client.setMessageReaction).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("does NOT ack `captain received` when delivery is held behind a modal (#546)", async () => {
    // The HELD receipt already told the operator the message is stuck. Acking it
    // would contradict that line and arm a watchdog for a turn nobody was given.
    //
    // `handled: true` is the PRODUCTION pair here: deliverToCaptain only falls
    // back to the pane for gone/unsupported (`fallsBackToPane`), so held/queued/
    // accepted all return handled: true. A held+handled:false pair is unreachable.
    setTopic(stateRoot, "brove", 7);
    const begin = vi.fn();
    const d = deps({
      lifecycle: { begin },
      deliverInbound: vi.fn(async () => ({ handled: true, outcome: { status: "held", via: "claude-peer", reason: "permission-mode parity" } })),
    } as any);
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("ship it", 7, 555)]);
    await drained;
    const bodies = (d.sendReply as any).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies.some((t: string) => t === "✅ captain received")).toBe(false);
    expect(bodies.some((t: string) => t.includes("HELD"))).toBe(true);
    expect(begin).not.toHaveBeenCalled();
    // held is handled:true → the pane fallback must NOT run.
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("regression (#837): held is still seen after the fallback clears the outcome", async () => {
    // #837 sets `outcome = undefined` once the pane append succeeds, so a guard
    // placed AFTER that block cannot see "held". This drives the unreachable-ish
    // pair (held + handled:false) — the exact shape that composed with #837 to
    // redden CI — and asserts the early capture still suppresses the ack.
    setTopic(stateRoot, "brove", 7);
    const begin = vi.fn();
    const d = deps({
      lifecycle: { begin },
      deliverInbound: vi.fn(async () => ({ handled: false, outcome: { status: "held", via: "claude-peer", reason: "permission-mode parity" } })),
    } as any);
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsgWithId("ship it", 7, 555)]);
    await drained;
    const bodies = (d.sendReply as any).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies.some((t: string) => t === "✅ captain received")).toBe(false);
    expect(begin).not.toHaveBeenCalled();
    // The fallback DID run (handled:false), so the append happened and #837
    // cleared the outcome — yet the ack is still correctly suppressed.
    expect(d.appendCaptainMessage).toHaveBeenCalled();
    bridge.stop();
  });
});

describe("channel commands in a project topic (#cmds-anytopic)", () => {
  const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };

  it("/status runs and replies into the same topic, never appended", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/status", 7)]);
    await drained;
    expect(d.runCommand).toHaveBeenCalledWith(["status"]);
    expect(d.sendReply).toHaveBeenCalledWith(7, "output");
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("/effort (no arg) replies the effort panel into the topic, never appended", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/effort", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(7, "Effort mode:", expect.objectContaining({ inline_keyboard: expect.anything() }));
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("a recognized channel command from an unauthorized sender is rejected, never appended", async () => {
    setTopic(stateRoot, "brove", 7);
    const d = deps();
    const { bridge, drained } = drive({ cfg: baseCfg, ...d }, [topicMsg("/status", 7)]);
    await drained;
    expect(d.runCommand).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledWith(7, expect.stringContaining("not authorized"));
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });
});

describe("typing indicator", () => {
  it("hands the typing lifecycle to begin() instead of firing a single action", async () => {
    // #838: the bridge no longer fires a one-shot sendChatAction — Telegram
    // expires it in ~5s, so it carried no information. Ownership moved to the
    // lifecycle's keep-alive (see inbound-lifecycle.test.ts).
    setTopic(stateRoot, "brove", 7);
    const begin = vi.fn();
    const d = deps({ lifecycle: { begin } } as any);
    const { bridge, client, drained } = drive({ cfg: baseCfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(client.sendChatAction).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith("brove", 7);
    expect(d.appendCaptainMessage).toHaveBeenCalled();
    bridge.stop();
  });

  it("does NOT fire sendChatAction for a /notify command in a project topic", async () => {
    setTopic(stateRoot, "brove", 7);
    const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const begin = vi.fn();
    const d = deps({ lifecycle: { begin } } as any);
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/notify", 7)]);
    await drained;
    expect(client.sendChatAction).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("does NOT fire sendChatAction for a /status channel command in a project topic", async () => {
    setTopic(stateRoot, "brove", 7);
    const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps();
    const { bridge, client, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/status", 7)]);
    await drained;
    expect(client.sendChatAction).not.toHaveBeenCalled();
    expect(d.appendCaptainMessage).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("does not start a typing lifecycle for a /status channel command", async () => {
    setTopic(stateRoot, "brove", 7);
    const ctrlCfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const begin = vi.fn();
    const d = deps({ lifecycle: { begin } } as any);
    const { bridge, drained } = drive({ cfg: ctrlCfg, ...d }, [topicMsg("/status", 7)]);
    await drained;
    expect(begin).not.toHaveBeenCalled();
    bridge.stop();
  });
});

import { formatInboundReceipt } from "./bridge.js";

describe("formatInboundReceipt (#667 slice 4)", () => {
  it("stays silent when there is no outcome — today's behaviour with the flag off", () => {
    expect(formatInboundReceipt("demo", undefined)).toBeUndefined();
  });

  it("stays silent on a plain confirmed accept — a receipt for every message would flood the phone", () => {
    expect(formatInboundReceipt("demo", { status: "accepted", via: "claude-peer", confirmed: true })).toBeUndefined();
  });

  it("speaks up when held, because a human must act", () => {
    expect(formatInboundReceipt("demo", { status: "held", via: "claude-peer", reason: "permission-mode parity" }))
      .toBe("⏸ Your message to demo is HELD awaiting approval in that session: permission-mode parity");
  });

  it("speaks up when the captain is gone", () => {
    expect(formatInboundReceipt("demo", { status: "gone" }))
      .toBe("⚠ demo's captain is not reachable — your message went to its mailbox instead");
  });

  it("speaks up on an unconfirmed accept rather than implying delivery", () => {
    expect(formatInboundReceipt("demo", { status: "accepted", via: "claude-peer", confirmed: false }))
      .toBe("… Your message reached demo's session but no turn was observed yet");
  });

  it("stays silent on queued — a mid-turn captain will see it next turn (#769)", () => {
    expect(formatInboundReceipt("demo", { status: "queued", via: "claude-peer" })).toBeUndefined();
  });
});
