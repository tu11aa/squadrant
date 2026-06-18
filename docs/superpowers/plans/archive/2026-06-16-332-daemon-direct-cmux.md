# #332 Daemon-Direct cmux Implementation Plan

> **✅ Shipped** (PR #342, 2026-06-16). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the notify-relay by letting the daemon call cmux directly (socket reachable from any process on cmux 0.64.16), behind a `daemonDirectCmux` flag, with byte-identical behaviour when the flag is OFF.

**Architecture:** The cmux `RuntimeDriver` (`src/runtimes/cmux.ts`) already implements `sendToSurface`/`listSurfaces`/`readScreen` + `DeferDelivery`. The daemon gains its own `RuntimeDriver` instance and, when `daemonDirectCmux` is ON, runs the relay's three jobs (notify EGRESS, surface-liveness probe, blocked pane-probe) itself instead of proxying through the relay tab. All cmux calls are fail-soft (errors → `"unknown"`/no-op, never a false reap). A new captain-close detector replaces the "relay heartbeat stops when workspace dies" reap signal.

**Tech Stack:** TypeScript, Node, vitest, cmux CLI (`src/lib/cmux-bin.ts`), unix-socket daemon (`src/control/cockpitd.ts`).

**Reference spec:** `docs/superpowers/specs/2026-06-16-332-daemon-direct-cmux-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/config.ts` | add `defaults.daemonDirectCmux: false` |
| `src/control/cmux/daemon-cmux.ts` | **NEW** — thin daemon-side accessor: resolve/hold a cmux `RuntimeDriver`, wrap its 3 methods fail-soft, expose `isAvailable()`. The #333 `LifecycleSource` will sit beside this. |
| `src/control/cockpitd.ts` | when flag ON: instantiate daemon-cmux; run delivery loop (job 1) + inline probes (jobs 2/3); captain-surface discovery + captain-close reap; gate the `relay-proxy-poll`/`relay-proxy-result` queue off |
| `src/control/delivery/captain-delivery.ts` | **NEW** — the ported `drain()` + defer-while-typing state machine (extracted so it is unit-testable without the daemon socket) |
| `src/commands/notify-relay.ts` | unchanged when flag OFF; not spawned when flag ON (deletion deferred to follow-on PR) |
| `plugin/skills/captain-ops/SKILL.md` | startup: skip `relay supervise` when flag ON |
| `src/control/__tests__/daemon-cmux.test.ts` | NEW tests |
| `src/control/delivery/__tests__/captain-delivery.test.ts` | NEW tests |
| `src/control/__tests__/cockpitd-daemon-direct.test.ts` | NEW tests |

**Decomposition note for the implementer:** the defer-while-typing logic currently lives inline in `notify-relay.ts:251-323` (`drain()`). Extract it into `captain-delivery.ts` as a pure-ish state machine (input: mailbox entries + a `send(text, {probe})` callback that may throw `DeferDelivery`; state: `deferCounts`/`stableCounts`/`lastContent`). Both the relay (flag OFF) and the daemon (flag ON) then consume the SAME module — this guarantees parity and is the safest way to "port, don't rewrite" the delicate #258/#268/#294/#302 code.

---

## Task 1: Config flag

**Files:**
- Modify: `src/config.ts` (the `defaults` block)
- Test: `src/__tests__/config.test.ts` (or the existing config test file — locate with `grep -rl "defaults" src/__tests__`)

- [ ] **Step 1: Write the failing test**

```ts
it("daemonDirectCmux defaults to false", () => {
  const cfg = loadConfig(/* fixture or default-construction path used by sibling tests */);
  expect(cfg.defaults?.daemonDirectCmux).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/__tests__/config.test.ts -t daemonDirectCmux`
Expected: FAIL (`daemonDirectCmux` undefined).

- [ ] **Step 3: Add the flag**

In `src/config.ts`, add `daemonDirectCmux: false` to the `defaults` object and to its TypeScript type/interface (mirror how `crewRouting` / existing `defaults.*` booleans are typed). Keep it a plain boolean.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/__tests__/config.test.ts -t daemonDirectCmux` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(#332): add daemonDirectCmux config flag (default false)"
```

---

## Task 2: `daemon-cmux` accessor (fail-soft wrapper)

**Files:**
- Create: `src/control/cmux/daemon-cmux.ts`
- Test: `src/control/__tests__/daemon-cmux.test.ts`

Read first: `src/runtimes/cmux.ts` (the `sendToSurface`/`listSurfaces`/`readScreen`/`DeferDelivery` definitions) and `src/runtimes/registry.ts` (how a runtime is constructed) to mirror exact constructor/usage.

- [ ] **Step 1: Write the failing tests**

```ts
describe("DaemonCmux", () => {
  it("listSurfaces failure returns [] (never throws into the caller)", async () => {
    const driver = { listSurfaces: async () => { throw new Error("socket down"); } } as any;
    const dc = new DaemonCmux(driver);
    await expect(dc.listSurfaces("ws1")).resolves.toEqual([]);
  });

  it("readScreen failure returns null", async () => {
    const driver = { readScreen: async () => { throw new Error("nope"); } } as any;
    const dc = new DaemonCmux(driver);
    await expect(dc.readScreen("surface:1")).resolves.toBeNull();
  });

  it("send re-throws DeferDelivery (so the delivery loop can defer), swallows other errors", async () => {
    const deferDriver = { sendToSurface: async () => { throw new DeferDelivery("draft"); } } as any;
    await expect(new DaemonCmux(deferDriver).send({ ref: "s" } as any, "hi")).rejects.toBeInstanceOf(DeferDelivery);
    const errDriver = { sendToSurface: async () => { throw new Error("boom"); } } as any;
    await expect(new DaemonCmux(errDriver).send({ ref: "s" } as any, "hi")).resolves.toBeUndefined();
  });

  it("isAvailable() is true when listSurfaces resolves, false when it throws", async () => {
    expect(await new DaemonCmux({ listSurfaces: async () => [] } as any).isAvailable()).toBe(true);
    expect(await new DaemonCmux({ listSurfaces: async () => { throw new Error(); } } as any).isAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/control/__tests__/daemon-cmux.test.ts`
Expected: FAIL (`DaemonCmux` not defined).

- [ ] **Step 3: Implement**

```ts
// src/control/cmux/daemon-cmux.ts
import type { RuntimeDriver, PaneRef } from "../../runtimes/types";
import { DeferDelivery } from "../../runtimes/cmux";

/**
 * #332: daemon-side cmux access. The daemon (a launchd process, NOT a cmux
 * descendant) can now drive cmux directly because the CLI auto-discovers its
 * canonical socket (~/.local/state/cmux/cmux.sock) from any process.
 *
 * Every method is FAIL-SOFT: a cmux/socket error degrades to a safe sentinel
 * ([] / null / no-op) so a transient failure NEVER false-reaps a live crew.
 * The ONE exception is DeferDelivery, which `send` re-throws so the delivery
 * loop can defer-while-typing (#258/#302).
 *
 * This is the seam #333's LifecycleSource port sits beside.
 */
export class DaemonCmux {
  constructor(private readonly driver: RuntimeDriver) {}

  async send(surface: PaneRef, text: string, opts?: { probe?: boolean }): Promise<void> {
    try {
      await this.driver.sendToSurface(surface, text, opts);
    } catch (e) {
      if (e instanceof DeferDelivery) throw e; // let the loop defer
      // swallow — best-effort delivery; the loop retries next tick
    }
  }

  async listSurfaces(workspaceId: string): Promise<PaneRef[]> {
    try { return await this.driver.listSurfaces(workspaceId); }
    catch { return []; } // [] → surfaceVerdict treats as "unknown", never reaps
  }

  async readScreen(ref: string): Promise<string | null> {
    try { return await this.driver.readScreen(ref); }
    catch { return null; }
  }

  async isAvailable(): Promise<boolean> {
    try { await this.driver.listSurfaces(""); return true; }
    catch { return false; }
  }
}
```

(If `listSurfaces("")` is not a safe probe against the real driver, replace the `isAvailable` body with a `cmux ping` via `src/lib/cmux-bin.ts` — check that file for an existing ping helper before adding one.)

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/control/__tests__/daemon-cmux.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/cmux/daemon-cmux.ts src/control/__tests__/daemon-cmux.test.ts
git commit -m "feat(#332): fail-soft daemon-side cmux accessor"
```

---

## Task 3: Extract the defer-while-typing delivery state machine

**Files:**
- Create: `src/control/delivery/captain-delivery.ts`
- Test: `src/control/delivery/__tests__/captain-delivery.test.ts`
- Read first: `src/commands/notify-relay.ts:251-323` (`drain()` + the `DeferDelivery` catch block) — this is the logic being extracted verbatim.

**Goal of this task:** move the defer/stable/maxDefers logic out of `notify-relay.ts` into a standalone, unit-testable module, with NO behaviour change. The relay will consume it in Task 6; the daemon consumes it in Task 4.

- [ ] **Step 1: Write failing tests capturing today's behaviour**

```ts
describe("captain-delivery defer-while-typing (#258/#302)", () => {
  // send() throws DeferDelivery while "typing"; resolves when not.
  it("defers while the captain is typing, delivers once clear", async () => {
    let typing = true;
    const sent: string[] = [];
    const d = new CaptainDelivery({ maxDefers: 300, stableProbePolls: 3 });
    const send = async (text: string) => { if (typing) throw new DeferDelivery("draft"); sent.push(text); };
    await d.deliver({ seq: 1, text: "hello" }, send); // deferred
    expect(sent).toEqual([]);
    typing = false;
    await d.deliver({ seq: 1, text: "hello" }, send); // now delivers
    expect(sent).toEqual(["hello"]);
  });

  it("escalates to a probe send after stableProbePolls of byte-identical draft", async () => {
    const probes: boolean[] = [];
    const d = new CaptainDelivery({ maxDefers: 300, stableProbePolls: 3 });
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      if (!opts?.probe) throw new DeferDelivery("same-draft"); // identical draft each poll
    };
    for (let i = 0; i < 4; i++) await d.deliver({ seq: 7, text: "x" }, send);
    expect(probes[probes.length - 1]).toBe(true); // last attempt was a probe
  });

  it("force-delivers (probe) after maxDefers regardless of stability", async () => {
    const probes: boolean[] = [];
    const d = new CaptainDelivery({ maxDefers: 2, stableProbePolls: 999 });
    let n = 0;
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      if (!opts?.probe && n++ < 5) throw new DeferDelivery(`draft-${n}`); // changing draft → never "stable"
    };
    for (let i = 0; i < 4; i++) await d.deliver({ seq: 9, text: "x" }, send);
    expect(probes.includes(true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/control/delivery/__tests__/captain-delivery.test.ts`
Expected: FAIL (`CaptainDelivery` not defined).

- [ ] **Step 3: Implement by lifting the logic from `drain()`**

Move the per-seq maps (`deferCounts`, `stableCounts`, `lastContent`) and the `DeferDelivery` catch behaviour from `notify-relay.ts:276-309` into a class. The `deliver(entry, send)` method computes `stable = (stableCounts >= stableProbePolls)` and `probe = stable || deferCount >= maxDefers`, calls `send(entry.text, probe ? {probe:true} : undefined)`, and on `DeferDelivery` updates `deferCounts`/`stableCounts`/`lastContent` exactly as the relay does today. Return a discriminated result (`{delivered:true}` | `{deferred:true}`) so callers can decide whether to advance the cursor.

Keep the constants sourced the same way the relay sources them (config `relay.maxDeferDeliveries`, `stableProbePolls`).

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/control/delivery/__tests__/captain-delivery.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/delivery/captain-delivery.ts src/control/delivery/__tests__/captain-delivery.test.ts
git commit -m "refactor(#332): extract defer-while-typing into CaptainDelivery (no behaviour change)"
```

---

## Task 4: Daemon-direct EGRESS (notify delivery) behind the flag

**Files:**
- Modify: `src/control/cockpitd.ts` (add a delivery loop gated on `daemonDirectCmux`)
- Test: `src/control/__tests__/cockpitd-daemon-direct.test.ts`
- Read first: how the daemon is constructed (`createDaemon`/`opts`), how the relay obtains `captainSurface` (`notify-relay.ts` top), and the mailbox cursor reader (`readFromCursor`/`writeCursor`).

- [ ] **Step 1: Write the failing test**

```ts
it("flag ON: daemon delivers queued captain messages via DaemonCmux + CaptainDelivery", async () => {
  // Arrange a daemon with daemonDirectCmux:true, a fake DaemonCmux capturing sends,
  // and a mailbox seeded with one entry. Tick the delivery loop once.
  // Assert the fake captured the message text and the cursor advanced.
});

it("flag OFF: daemon does NOT run the delivery loop (relay path owns it)", async () => {
  // Daemon with daemonDirectCmux:false → fake DaemonCmux.send never called.
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/control/__tests__/cockpitd-daemon-direct.test.ts -t "daemon delivers"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `createDaemon`, when `cfg.defaults?.daemonDirectCmux`:
1. Instantiate `new DaemonCmux(runtime)` (the daemon already has/constructs a cmux runtime — reuse it; if not, construct via `registry`).
2. Add a `setInterval` delivery loop (reuse `pollMs`) that, per project with a live captain surface: reads mailbox entries from the cursor, feeds each through a `CaptainDelivery` instance whose `send` calls `daemonCmux.send(captainSurface, text, opts)`, and advances the cursor only on `{delivered:true}`.
3. Resolve `captainSurface` via Task 5's discovery.
4. Guard the whole loop behind the flag so flag-OFF is a no-op.

- [ ] **Step 4: Run, verify pass** → both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control/cockpitd.ts src/control/__tests__/cockpitd-daemon-direct.test.ts
git commit -m "feat(#332): daemon-direct captain notify delivery behind flag"
```

---

## Task 5: Captain-surface discovery + captain-close reap (#324)

**Files:**
- Modify: `src/control/cockpitd.ts`
- Test: `src/control/__tests__/cockpitd-daemon-direct.test.ts`
- Read first: `crewPaneTitle`/captain pane-title convention (`grep -rn "captainName\|crewPaneTitle\|cockpit-captain" src`).

- [ ] **Step 1: Write failing tests**

```ts
it("discovers the captain surface by pane title from listSurfaces", async () => {
  const dc = { listSurfaces: async () => [{ ref: "s9", title: "⚓ cockpit-captain" }] } as any;
  expect((await discoverCaptainSurface(dc, "cockpit", "⚓ cockpit-captain"))?.ref).toBe("s9");
});

it("reaps the captain as closed after K consecutive sweeps with no captain surface", async () => {
  // listSurfaces returns [] for K sweeps → onCaptainClosed fired once, delivery loop stops.
});

it("does NOT reap on a single transient empty sweep (K>1)", async () => {
  // [] once then present again → no reap.
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

Add `discoverCaptainSurface(dc, project, captainTitle)` = `(await dc.listSurfaces(ws.id)).find(s => s.title === captainTitle) ?? null`. Track a per-project `captainMissingStreak`; when `listSurfaces` is non-empty but the captain surface is absent for `K` (const, e.g. 3) consecutive sweeps, fire the existing captain-gone reap path (the one previously triggered by lost relay-heartbeat) and stop the delivery loop for that project. An **empty** `listSurfaces` result (cmux unreachable) is `"unknown"` → does NOT increment the streak (fail-soft, never false-reap).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/control/cockpitd.ts src/control/__tests__/cockpitd-daemon-direct.test.ts
git commit -m "feat(#332,#324): daemon-side captain-surface discovery + captain-close reap"
```

---

## Task 6: Daemon-direct INGEST probes (jobs 2/3) + retire the proxy queue under the flag

**Files:**
- Modify: `src/control/cockpitd.ts` (the `proxiedSurfaceAlive`/`pendingProbes`/`probeResults`/`inFlightProbes` path, L216-241; the `relay-proxy-poll`/`relay-proxy-result` handlers, L638-652)
- Test: `src/control/__tests__/cockpitd-daemon-direct.test.ts`
- Read first: `surfaceVerdict` + `crewPaneTitle` (`grep -rn "surfaceVerdict\|crewPaneTitle" src`), and `createInteractiveProbe`/`createCrewPaneReader` (`src/commands/notify-relay.ts`).

- [ ] **Step 1: Write failing tests**

```ts
it("flag ON: surface liveness uses DaemonCmux.listSurfaces + surfaceVerdict inline (no proxy queue)", async () => {
  // DaemonCmux returns surfaces incl. the crew pane title → verdict "alive"; absent → "gone".
});

it("flag ON: DaemonCmux.listSurfaces failure yields 'unknown' (no reap)", async () => {
  // listSurfaces throws → [] → surfaceVerdict(null/[],..) → "unknown".
});

it("flag OFF: relay-proxy-poll/result handlers still work (relay path intact)", async () => {
  // existing relay-proxy round-trip unchanged.
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

When flag ON, `proxiedSurfaceAlive(rec)` becomes direct: `surfaceVerdict(await daemonCmux.listSurfaces(ws.id) map titles, crewPaneTitle(project, rec.name))` — no enqueue, no cache, no `inFlightProbes`. Move the blocked pane-probe (`createCrewPaneReader` → `daemonCmux.readScreen`) into the same sweep. Keep `surfaceVerdict` and the pane-parse logic **unchanged**. Leave the `relay-proxy-poll`/`relay-proxy-result` handlers in place for flag-OFF (deleted in the follow-on PR).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/control/cockpitd.ts src/control/__tests__/cockpitd-daemon-direct.test.ts
git commit -m "feat(#332): daemon-direct surface-liveness + blocked probe behind flag"
```

---

## Task 7: Relay spawn gating (flag ON ⇒ relay not spawned)

**Files:**
- Modify: `plugin/skills/captain-ops/SKILL.md` (startup step 8)
- Modify: `src/commands/relay.ts` (the `relay supervise` entrypoint) — early-exit with a clear log if `daemonDirectCmux` is ON
- Modify: `src/commands/notify-relay.ts` — make the relay consume `CaptainDelivery` from Task 3 (so flag-OFF parity is via the SAME module)
- Test: `src/commands/__tests__/relay.test.ts`

- [ ] **Step 1: Write failing test**

```ts
it("relay supervise no-ops when daemonDirectCmux is ON", async () => {
  // config flag ON → supervise() logs "daemon-direct active; relay disabled" and does not start the loop.
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

In `relay supervise`, read the flag; if ON, log `daemon-direct active; relay disabled (#332)` and return without starting intervals. Rewire `notify-relay.ts`'s `drain()` to call `CaptainDelivery.deliver` (Task 3) so both paths share one implementation. Update `captain-ops/SKILL.md` step 8 to: "If `defaults.daemonDirectCmux` is ON, skip `relay supervise` — the daemon owns notification delivery."

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/commands/relay.ts src/commands/notify-relay.ts src/commands/__tests__/relay.test.ts plugin/skills/captain-ops/SKILL.md
git commit -m "feat(#332): gate relay spawn off when daemonDirectCmux is ON; relay shares CaptainDelivery"
```

---

## Task 8: Full-suite parity + flag-OFF regression gate

**Files:** none (verification task)

- [ ] **Step 1:** Run the full suite on a clean checkout: `npm test`. Expected: all green, including the existing `relay-proxy.test.ts`, `notify-relay.test.ts`, `daemon-relay-health.test.ts` (flag defaults OFF → these must be untouched).

- [ ] **Step 2:** Manual flag-OFF smoke (default): boot a captain + a crew, confirm a crew DONE notification still lands and defer-while-typing still defers — identical to today.

- [ ] **Step 3:** Manual flag-ON smoke: set `defaults.daemonDirectCmux: true`, restart the daemon, do NOT spawn the relay. Confirm: (a) crew DONE notification lands via daemon-direct, (b) typing in the captain pane defers delivery then escalates, (c) closing the captain workspace is detected (captain-close reap within K sweeps), (d) no false crew reaps when cmux is briefly unreachable.

- [ ] **Step 4:** Record results in the PR description (evidence before claiming done — superpowers:verification-before-completion).

---

## Self-Review (done by author)

- **Spec coverage:** §3 cutover→Task 1+7+8; §5.1 seam→Task 2; §5.2 EGRESS→Task 3+4; §5.3 probes→Task 6; §5.4 captain-close→Task 5; §5.5 relay lifecycle→Task 7; §8 success criteria→Task 8. Covered.
- **Out of scope confirmed:** no source-of-truth change (scrape kept verbatim); #333/#338 untouched.
- **Type consistency:** `DaemonCmux` (Task 2), `CaptainDelivery` (Task 3) names used consistently in Tasks 4/5/6/7. `daemonDirectCmux` flag name consistent throughout.
- **Known gap handed to implementer:** exact daemon runtime construction + mailbox cursor API are referenced by "read first" notes — the implementer reads `cockpitd.ts`/`notify-relay.ts` to mirror real signatures (TDD will surface any mismatch).
