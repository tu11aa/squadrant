import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelegramBridge } from "../bridge.js";
import { saveProjectOverride } from "@squadrant/shared";
import { setNotify } from "../state.js";

function harness(root: string, globalNotify?: any) {
  const sent: string[] = [];
  const client = {
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async (_c: number, _t: number | undefined, text: string) => { sent.push(text); }),
    createForumTopic: vi.fn(async () => 111),
    getMe: vi.fn(async () => ({ id: 1, username: "bot" })),
  };
  const bridge = createTelegramBridge({
    cfg: { supergroupId: -100, chats: [], notify: globalNotify } as any,
    stateRoot: root, configRoot: root, client: client as any,
    appendCaptainMessage: vi.fn(), log: vi.fn(),
  });
  return { bridge, sent, client };
}

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-br-")); });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("deliverOutbound notify resolution", () => {
  it("drops everything when muted (default, absent state)", async () => {
    const { bridge, sent } = harness(root);
    bridge.pushLifecycle("p", { type: "task.done", id: "t1", resultRef: "r" } as any);
    await flush();
    expect(sent).toEqual([]);
  });

  it("alert_only sends outcomes + alerts but drops progress noise when active", async () => {
    // alert_only is cumulative (⊇ done_only), so task.done IS included; the tier
    // filter only drops the non-alert noise (e.g. task.progress). See tiers.ts.
    setNotify(root, "p", true); // live unmute
    const { bridge, sent } = harness(root); // global default crew=alert_only
    bridge.pushLifecycle("p", { type: "task.progress", id: "t1", note: "n" } as any);
    bridge.pushLifecycle("p", { type: "task.blocked", id: "t2", reason: "x", question: "q" } as any);
    bridge.pushLifecycle("p", { type: "task.done", id: "t3", resultRef: "r" } as any);
    await flush();
    expect(sent.some((t) => t.includes("task.progress"))).toBe(false);
    expect(sent.some((t) => t.includes("BLOCKED"))).toBe(true);
    expect(sent.some((t) => t.includes("CREW DONE"))).toBe(true);
  });

  it("project crew=all sends progress when active", async () => {
    setNotify(root, "p", true);
    saveProjectOverride("p", { telegram: { notify: { crew: "all" } } }, root);
    const { bridge, sent } = harness(root);
    bridge.pushLifecycle("p", { type: "task.progress", id: "t1", note: "n" } as any);
    await flush();
    expect(sent.length).toBe(1);
  });

  it("config-default active=true sends with absent live state", async () => {
    saveProjectOverride("p", { telegram: { notify: { active: true } } }, root);
    const { bridge, sent } = harness(root);
    bridge.pushLifecycle("p", { type: "task.done", id: "t1", resultRef: "r" } as any);
    // crew default alert_only includes task.done
    await flush();
    expect(sent.length).toBe(1);
  });
});
