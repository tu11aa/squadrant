// src/control/__tests__/cockpitd-relay-health.test.ts
//
// End-to-end through the real socket: relay-register/heartbeat routing and the
// #77 health verb assembly (with an injected captainProbe — no cmux). Covers the
// #207 "captain SILENTLY blind" case: a live captain with NO relay → relay gone
// + actionable.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";
import type { ComponentHealth } from "../liveness.js";

const find = (cs: ComponentHealth[], kind: ComponentHealth["kind"]) =>
  cs.find((c) => c.kind === kind);

describe("cockpitd relay-health socket (#207/#77)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  function boot(captainPresent: boolean | null) {
    dir = mkdtempSync(join(tmpdir(), "cp-crh-"));
    const sock = join(dir, "c.sock");
    const handle = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: sock,
      sweepMs: 0,
      captainProbe: async () => captainPresent,
    });
    stop = handle.stop;
    return sock;
  }

  it("relay-register → health shows the relay alive with its pid", async () => {
    const sock = boot(true);
    const ok: any = await sendRequest(sock, { kind: "relay-register", project: "p", pid: 4242, startedAt: 1 });
    expect(ok).toEqual({ ok: true });
    const cs: ComponentHealth[] = await sendRequest(sock, { kind: "health", project: "p" }) as any;
    const relay = find(cs, "relay")!;
    expect(relay.state).toBe("alive");
    expect(relay.detail).toContain("4242");
    expect(find(cs, "captain")!.state).toBe("alive");
  });

  it("live captain but NO relay registered → relay GONE with actionable (never silently blind)", async () => {
    const sock = boot(true);
    const cs: ComponentHealth[] = await sendRequest(sock, { kind: "health", project: "p" }) as any;
    const relay = find(cs, "relay")!;
    expect(relay.state).toBe("gone");
    expect(relay.detail).toContain("cockpit launch p");
  });

  it("relay-heartbeat keeps the relay registered/alive", async () => {
    const sock = boot(null);
    await sendRequest(sock, { kind: "relay-register", project: "p", pid: 7, startedAt: 1 });
    const ok: any = await sendRequest(sock, { kind: "relay-heartbeat", project: "p", pid: 7 });
    expect(ok).toEqual({ ok: true });
    const cs: ComponentHealth[] = await sendRequest(sock, { kind: "health", project: "p" }) as any;
    expect(find(cs, "relay")!.state).toBe("alive");
  });
});
