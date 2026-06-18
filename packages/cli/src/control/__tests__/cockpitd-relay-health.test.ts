// src/control/__tests__/cockpitd-relay-health.test.ts
//
// End-to-end through the real socket: relay-register/heartbeat routing and the
// #77 health verb assembly. Captain liveness is derived from relay heartbeat
// (#239 Phase A) — no cmux probe injection needed.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "@cockpit/core";
import type { ComponentHealth } from "@cockpit/core";

const find = (cs: ComponentHealth[], kind: ComponentHealth["kind"]) =>
  cs.find((c) => c.kind === kind);

describe("cockpitd relay-health socket (#207/#77)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  function boot() {
    dir = mkdtempSync(join(tmpdir(), "cp-crh-"));
    const sock = join(dir, "c.sock");
    const handle = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: sock,
      sweepMs: 0,
    });
    stop = handle.stop;
    return sock;
  }

  it("relay-register → health shows the relay alive with its pid, captain alive", async () => {
    const sock = boot();
    const ok: any = await sendRequest(sock, { kind: "relay-register", project: "p", pid: 4242, startedAt: 1 });
    expect(ok).toEqual({ ok: true });
    const cs: ComponentHealth[] = await sendRequest(sock, { kind: "health", project: "p" }) as any;
    const relay = find(cs, "relay")!;
    expect(relay.state).toBe("alive");
    expect(relay.detail).toContain("4242");
    // captain liveness from relay heartbeat (#239): relay alive → captain alive
    expect(find(cs, "captain")!.state).toBe("alive");
  });

  it("no relay registered → relay unknown, captain unknown (#239 Phase A: no cmux probe)", async () => {
    // Without captainPresent signal (cmux-denied from launchd), relay-null is
    // "unknown" — we cannot distinguish "relay dead" from "nothing running".
    const sock = boot();
    const cs: ComponentHealth[] = await sendRequest(sock, { kind: "health", project: "p" }) as any;
    expect(find(cs, "relay")!.state).toBe("unknown");
    expect(find(cs, "captain")!.state).toBe("unknown");
  });

  it("relay-heartbeat keeps the relay registered/alive", async () => {
    const sock = boot();
    await sendRequest(sock, { kind: "relay-register", project: "p", pid: 7, startedAt: 1 });
    const ok: any = await sendRequest(sock, { kind: "relay-heartbeat", project: "p", pid: 7 });
    expect(ok).toEqual({ ok: true });
    const cs: ComponentHealth[] = await sendRequest(sock, { kind: "health", project: "p" }) as any;
    expect(find(cs, "relay")!.state).toBe("alive");
  });
});
