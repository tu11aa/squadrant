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

  it("warns into the topic when warmup times out but still queues the message", async () => {
    setTopic(stateRoot, "brove", 7);
    const cfg = { ...baseCfg, remoteControl: true, users: [ALLOWED_USER] };
    const d = deps({ ensureCaptainAlive: vi.fn(async () => "timeout" as const) });
    const { bridge, drained } = drive({ cfg, ...d }, [topicMsg("ship it", 7)]);
    await drained;
    expect(d.sendReply).toHaveBeenCalledWith(7, expect.stringContaining("warm up"));
    expect(d.appendCaptainMessage).toHaveBeenCalled();
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
