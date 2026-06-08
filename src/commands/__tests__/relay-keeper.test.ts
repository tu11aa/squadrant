// src/commands/__tests__/relay-keeper.test.ts
//
// #224: relay-keeper — pure decision fn + tick integration tests.
import { describe, it, expect, vi } from "vitest";
import { decideKeeperAction, runRelayKeeperTick } from "../relay-keeper.js";
import { NOTIFY_RELAY_TAB_TITLE } from "../../control/relay-supervisor.js";
import type { ComponentHealth } from "../../control/liveness.js";

function health(opts: Partial<ComponentHealth> & { kind: ComponentHealth["kind"]; project: string }): ComponentHealth {
  return {
    state: "alive",
    lastSeenMs: null,
    ...opts,
  } as ComponentHealth;
}

// ── Pure decision function ──────────────────────────────────────────────

describe("decideKeeperAction (pure)", () => {
  it("skips when relay is alive", () => {
    const h = [health({ kind: "relay", project: "p", state: "alive" })];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "relay is alive" });
  });

  it("skips when relay is stale", () => {
    const h = [health({ kind: "relay", project: "p", state: "stale" })];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "relay is stale" });
  });

  it("skips when relay is gone but captain is absent", () => {
    const h = [
      health({ kind: "relay", project: "p", state: "gone" }),
      health({ kind: "captain", project: "p", state: "gone" }),
    ];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "captain not alive (gone)" });
  });

  it("skips when relay is gone but captain is unknown", () => {
    const h = [
      health({ kind: "relay", project: "p", state: "gone" }),
      health({ kind: "captain", project: "p", state: "unknown" }),
    ];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "captain not alive (unknown)" });
  });

  it("skips when relay is unknown and captain is alive — only respawn on explicit gone", () => {
    const h = [
      health({ kind: "relay", project: "p", state: "unknown" }),
      health({ kind: "captain", project: "p", state: "alive" }),
    ];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "relay is unknown" });
  });

  it("respawns when relay is gone and captain is alive", () => {
    const h = [
      health({ kind: "relay", project: "p", state: "gone" }),
      health({ kind: "captain", project: "p", state: "alive" }),
    ];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "respawn" });
  });

  it("skips when no relay health data at all", () => {
    const h = [health({ kind: "captain", project: "p", state: "alive" })];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "no relay health data" });
  });

  it("skips when health data belongs to a different project", () => {
    const h = [
      health({ kind: "relay", project: "other", state: "gone" }),
      health({ kind: "captain", project: "other", state: "alive" }),
    ];
    expect(decideKeeperAction(h, "p")).toEqual({ action: "skip", reason: "no relay health data" });
  });

  it("skips when relay gone with no explicit captain row (conservative — don't assume present)", () => {
    const h = [health({ kind: "relay", project: "p", state: "gone" })];
    const r = decideKeeperAction(h, "p");
    expect(r.action).toBe("skip");
    if (r.action === "skip") expect(r.reason).toMatch(/captain not alive/);
  });
});

// ── Tick routing (injected fetchHealth) ─────────────────────────────────

describe("runRelayKeeperTick (routing)", () => {
  it("calls closePane + spawnInjector when relay is gone and captain is alive", async () => {
    const closePane = vi.fn().mockResolvedValue(undefined);
    const spawnInjector = vi.fn().mockResolvedValue({ surfaceId: "s1" });
    const runtime = {
      status: vi.fn().mockResolvedValue({ id: "ws:1", name: "captain", status: "running" as const }),
      listSurfaces: vi.fn().mockResolvedValue([
        { workspaceId: "ws:1", surfaceId: "s1", title: NOTIFY_RELAY_TAB_TITLE },
      ]),
      closePane,
      spawnInjector,
    };

    await runRelayKeeperTick(
      "p",
      runtime as never,
      "captain",
      vi.fn(),
      async () => [
        health({ kind: "relay", project: "p", state: "gone" }),
        health({ kind: "captain", project: "p", state: "alive" }),
      ],
    );

    // closePane must be called on the existing relay tab before injecting
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane.mock.calls[0][0]).toMatchObject({ surfaceId: "s1" });
    // spawnInjector must be called with the relay title and supervisor command
    expect(spawnInjector).toHaveBeenCalledTimes(1);
    expect(spawnInjector.mock.calls[0][0]).toMatchObject({
      title: NOTIFY_RELAY_TAB_TITLE,
      placement: "background",
    });
    expect(spawnInjector.mock.calls[0][0].command).toContain("cockpit notify-relay p --as captain");
  });

  it("does NOT call closePane or spawnInjector when relay is alive", async () => {
    const closePane = vi.fn();
    const spawnInjector = vi.fn();
    const runtime = {
      status: vi.fn(),
      listSurfaces: vi.fn(),
      closePane,
      spawnInjector,
    };

    await runRelayKeeperTick(
      "p",
      runtime as never,
      "captain",
      vi.fn(),
      async () => [
        health({ kind: "relay", project: "p", state: "alive" }),
        health({ kind: "captain", project: "p", state: "alive" }),
      ],
    );

    expect(closePane).not.toHaveBeenCalled();
    expect(spawnInjector).not.toHaveBeenCalled();
  });

  it("does NOT call closePane or spawnInjector when daemon is unreachable (fetchHealth throws)", async () => {
    const closePane = vi.fn();
    const spawnInjector = vi.fn();
    const runtime = {
      status: vi.fn(),
      listSurfaces: vi.fn(),
      closePane,
      spawnInjector,
    };

    await runRelayKeeperTick(
      "p",
      runtime as never,
      "captain",
      vi.fn(),
      async () => { throw new Error("socket not found"); },
    );

    expect(closePane).not.toHaveBeenCalled();
    expect(spawnInjector).not.toHaveBeenCalled();
  });
});
