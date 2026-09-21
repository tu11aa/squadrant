// #797 issue 1: an opencode captain whose recorded port is DEAD could never be
// healed — the self-heal re-resolved only the session id by dialing the same
// dead port, then threw a permanent `no-channel`. This pins the fix: discover
// the live server for the captain's directory/session, rewrite the record, and
// retry the delivery against the refreshed address (or fall back to the pane).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return { ...actual, loadConfig: loadConfigMock };
});

const discoverMock = vi.hoisted(() => vi.fn());
vi.mock("../opencode-session.js", () => ({
  listSessions: vi.fn(async () => []),
  newestSessionInDirectory: vi.fn(() => null),
  discoverLiveOpencodeServer: discoverMock,
}));

import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendCaptainMessage, readCursor } from "../mailbox.js";
import { writeCaptainAddress, readCaptainAddress } from "../captain-record.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";
import type { ControlChannel } from "../control-channel.js";

async function seed(stateRoot: string, project: string) {
  const store = createStore(stateRoot);
  store.put({
    id: "t1", project, provider: "opencode", mode: "interactive",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
  });
  const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
  livenessRegistry.apply({
    project, role: "captain", pid: 123, sessionId: "s1",
    startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
    pidAlive: true, source: "runtime",
  });
  await appendCaptainMessage({ stateRoot, project, text: "hello", source: "cli" });
  return { store, livenessRegistry };
}

describe("opencode captain address self-heal (#797)", () => {
  it("re-resolves the live port and retries delivery — not a permanent no-channel", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "deliv-797-"));
    const project = "alpha";
    const captainName = `${project}-captain`;
    loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
    const { store, livenessRegistry } = await seed(stateRoot, project);

    // The stale record: dead port 58525, live server is on 61099 (same session).
    writeCaptainAddress(stateRoot, project, {
      agent: "opencode", port: 58525, sessionId: "ses_old",
      directory: "/tmp/alpha", launchedAt: "2026-09-18T08:30:32.196Z",
    });
    discoverMock.mockReturnValue({ pid: 26805, port: 61099, sessionId: "ses_old" });

    // gone on the dead port, accepted once the record has been refreshed.
    let sends = 0;
    const channelSend = vi.fn(async () => {
      sends++;
      return sends === 1
        ? { status: "gone" as const }
        : { status: "accepted" as const, via: "opencode-http" };
    });
    const opencode: ControlChannel = {
      name: "opencode-http", agent: "opencode",
      send: channelSend,
      probe: vi.fn(async () => ({ status: "reachable" as const, via: "opencode-http" })),
    } as unknown as ControlChannel;

    const paneSend = vi.fn();
    const cmux = {
      listSurfaces: async () => [{ workspaceId: "w1", surfaceId: "surface:1", title: captainName }],
      findWorkspaceId: async () => "w1",
      send: paneSend,
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
      captainChannelMode: () => "on",
      captainChannels: { opencode },
      captainAgentFor: () => "opencode",
    } as any, cmux as any);

    await deliv.deliveryTick!();

    expect(discoverMock).toHaveBeenCalledWith({ directory: "/tmp/alpha", sessionId: "ses_old" });
    expect(readCaptainAddress(stateRoot, project)).toMatchObject({ port: 61099, sessionId: "ses_old" });
    expect(channelSend).toHaveBeenCalledTimes(2); // dead-port attempt + refreshed retry
    expect(paneSend).not.toHaveBeenCalled();
    const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });

  it("falls back to the pane (never a permanent no-channel) when no live server is found", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "deliv-797-gone-"));
    const project = "beta";
    const captainName = `${project}-captain`;
    loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
    const { store, livenessRegistry } = await seed(stateRoot, project);
    writeCaptainAddress(stateRoot, project, {
      agent: "opencode", port: 58525, sessionId: "ses_old",
      directory: "/tmp/beta", launchedAt: "2026-09-18T08:30:32.196Z",
    });
    discoverMock.mockReturnValue(null);

    const channelSend = vi.fn(async () => ({ status: "gone" as const }));
    const opencode: ControlChannel = {
      name: "opencode-http", agent: "opencode",
      send: channelSend,
      probe: vi.fn(async () => ({ status: "gone" as const })),
    } as unknown as ControlChannel;

    const paneSend = vi.fn(async (_s: unknown, _t: string, _o?: unknown) => {});
    const cmux = {
      listSurfaces: async () => [{ workspaceId: "w1", surfaceId: "surface:1", title: captainName }],
      findWorkspaceId: async () => "w1",
      send: paneSend,
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
      captainChannelMode: () => "on",
      captainChannels: { opencode },
      captainAgentFor: () => "opencode",
    } as any, cmux as any);

    await deliv.deliveryTick!();

    expect(paneSend).toHaveBeenCalledTimes(1);
    // #786: the pane path must receive the captain's agent so it selects the
    // opencode input-box gate rather than the claude parser.
    expect(paneSend.mock.calls[0]![2]).toMatchObject({ agent: "opencode" });
    expect(deliv.deliveryStats(project)?.reason).not.toBe("no-channel");
  });

  it("defers loudly (cursor not advanced) when the server is unreachable and the pane is not confirmable", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "deliv-797-defer-"));
    const project = "gamma";
    const captainName = `${project}-captain`;
    loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
    const { store, livenessRegistry } = await seed(stateRoot, project);
    writeCaptainAddress(stateRoot, project, {
      agent: "opencode", port: 58525, sessionId: "ses_old",
      directory: "/tmp/gamma", launchedAt: "2026-09-18T08:30:32.196Z",
    });
    discoverMock.mockReturnValue(null);

    const channelSend = vi.fn(async () => ({ status: "gone" as const }));
    const opencode: ControlChannel = {
      name: "opencode-http", agent: "opencode",
      send: channelSend,
      probe: vi.fn(async () => ({ status: "gone" as const })),
    } as unknown as ControlChannel;

    // The pane path (with agent="opencode") reports the box is NOT confirmed
    // empty (a draft / busy pane) — exactly what the opencode gate throws.
    const paneSend = vi.fn(async () => { throw new DeferDelivery(null, "no-box"); });
    const cmux = {
      listSurfaces: async () => [{ workspaceId: "w1", surfaceId: "surface:1", title: captainName }],
      findWorkspaceId: async () => "w1",
      send: paneSend,
    };
    const logs: string[] = [];
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: (m: string) => logs.push(m), isPidAlive: () => true, opts: {},
      captainChannelMode: () => "on",
      captainChannels: { opencode },
      captainAgentFor: () => "opencode",
    } as any, cmux as any);

    await deliv.deliveryTick!();

    // Attempted the pane, and the message is retained (cursor never advanced) —
    // a defer, not a silent ack.
    expect(paneSend).toHaveBeenCalledTimes(1);
    const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursor?.lastAckedSeq ?? 0).toBe(0);
    // Loud, not silent: the server-unreachable fallback is logged.
    expect(logs.some((l) => l.includes("no live opencode server — falling back to pane"))).toBe(true);
    expect(logs.some((l) => l.includes("outcome=deferred"))).toBe(true);
  });
});
