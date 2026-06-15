// src/control/telegram/__tests__/subsystem.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramSubsystem } from "../subsystem.js";
import type { TelegramClient } from "../client.js";
import type { TaskRecord } from "../../types.js";

function fakeClient(over: Partial<TelegramClient> = {}): TelegramClient {
  return {
    getMe: vi.fn(async () => {}),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => 42),
    closeForumTopic: vi.fn(async () => {}),
    ...over,
  };
}

function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "t1", project: "cockpit", name: "crew-1", provider: "claude", state: "working", mode: "interactive", task: "x", lastHeartbeat: 0, createdAt: 0, ...over } as TaskRecord;
}

const baseDeps = (client: TelegramClient, root: string) => ({
  client,
  chats: { cockpit: -100 },
  stateRoot: root,
  appendCaptainMessage: vi.fn(async () => 1),
  resolveCrewName: () => "crew-1",
  log: () => {},
});

describe("telegram subsystem — outbound", () => {
  it("creates a topic on first push and sends into it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "cockpit", message: "CREW BLOCKED: ?", record: rec() });
    expect(client.createForumTopic).toHaveBeenCalledWith(-100, "🔧 crew-1");
    expect(client.sendMessage).toHaveBeenCalledWith(-100, "CREW BLOCKED: ?", 42);
  });

  it("reuses an existing topic on the second push (no second create)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "cockpit", message: "a", record: rec() });
    await sub.pushLifecycle({ project: "cockpit", message: "b", record: rec() });
    expect(client.createForumTopic).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("no-ops for an unlinked project", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "brove", message: "x", record: rec({ project: "brove" }) });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("closes the topic after a terminal-state push", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "cockpit", message: "CREW DONE", record: rec({ state: "done" }) });
    expect(client.closeForumTopic).toHaveBeenCalledWith(-100, 42);
  });

  it("never throws when the client fails (best-effort)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient({ sendMessage: vi.fn(async () => { throw new Error("network down"); }) });
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await expect(sub.pushLifecycle({ project: "cockpit", message: "x", record: rec() })).resolves.toBeUndefined();
  });
});
