import { describe, it, expect } from "vitest";
import { CaptainDelivery } from "../captain-delivery.js";
import { DeferDelivery } from "../../delivery/defer-delivery.js";

describe("CaptainDelivery defer-while-typing (#258/#302)", () => {
  it("defers while the captain is typing, delivers once clear", async () => {
    let typing = true;
    const sent: string[] = [];
    const d = new CaptainDelivery({ maxDefers: 300, stableProbePolls: 3 });
    const send = async (text: string) => { if (typing) throw new DeferDelivery("draft"); sent.push(text); };
    await d.deliver({ seq: 1, message: "hello" }, send);
    expect(sent).toEqual([]);
    typing = false;
    await d.deliver({ seq: 1, message: "hello" }, send);
    expect(sent).toEqual(["hello"]);
  });

  it("escalates to a probe send after stableProbePolls of byte-identical draft", async () => {
    const probes: boolean[] = [];
    const d = new CaptainDelivery({ maxDefers: 300, stableProbePolls: 3 });
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      if (!opts?.probe) throw new DeferDelivery("same-draft");
    };
    for (let i = 0; i < 5; i++) await d.deliver({ seq: 7, message: "x" }, send);
    expect(probes[probes.length - 1]).toBe(true);
  });

  // #484 reopened (compose-box variant): the old `deferCount >= maxDefers` OR
  // clause escalated to a probe purely on defer COUNT, even while the draft was
  // still actively changing every poll — i.e. a human genuinely typing. Once
  // probe=true, sendToSurface sends a REAL backspace keystroke into the live
  // pane to run the structural liveness test (#258/#302); doing that against a
  // draft that hasn't stabilized risks racing the human's next keystroke and,
  // per #484's own root-cause analysis, eventually misclassifying and
  // force-delivering into it. An actively-changing draft must keep deferring
  // FOREVER (never probed) until it goes stable (paused) or empty (submitted) —
  // maxDefers alone must never be sufficient to escalate.
  it("never escalates to a probe while draft content keeps changing every poll, even long past maxDefers (#484 reopened fix)", async () => {
    const probes: boolean[] = [];
    const d = new CaptainDelivery({ maxDefers: 2, stableProbePolls: 999 });
    let n = 0;
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      // Content changes on every single poll — an actively-typing human, never stable.
      if (!opts?.probe) throw new DeferDelivery(`draft-${n++}`);
    };
    for (let i = 0; i < 10; i++) await d.deliver({ seq: 9, message: "x" }, send);
    expect(probes.every((p) => !p)).toBe(true);
    // Health-visibility metric still fires independently — maxDefers stays
    // meaningful as a "stuck" dashboard alarm, just not as a delivery trigger.
    expect(d.stats().stuck).toBe(true);
  });

  it("only escalates once content stops changing — a low maxDefers does not shortcut the stableProbePolls path", async () => {
    const probes: boolean[] = [];
    // maxDefers is deliberately LOW (past it in the first two "changing" polls
    // alone) to prove escalation still waits for stability, not defer count.
    const d = new CaptainDelivery({ maxDefers: 2, stableProbePolls: 3 });
    let changing = true;
    let n = 0;
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      if (opts?.probe) return;
      throw new DeferDelivery(changing ? `draft-${n++}` : "settled-draft");
    };
    // Changing content past maxDefers=2 — must never probe.
    for (let i = 0; i < 4; i++) await d.deliver({ seq: 5, message: "x" }, send);
    expect(probes.every((p) => !p)).toBe(true);
    // The human pauses: content goes byte-identical across consecutive polls.
    // Once stableCounts reaches stableProbePolls, escalation fires.
    changing = false;
    for (let i = 0; i < 6 && !probes[probes.length - 1]; i++) {
      await d.deliver({ seq: 5, message: "x" }, send);
    }
    expect(probes[probes.length - 1]).toBe(true);
  });

  it("returns { delivered: true } for null message (nothing to deliver)", async () => {
    const sent: string[] = [];
    const d = new CaptainDelivery({ maxDefers: 300, stableProbePolls: 3 });
    const result = await d.deliver({ seq: 99, message: null }, async (t) => { sent.push(t); });
    expect(result).toEqual({ delivered: true });
    expect(sent).toEqual([]);
  });

  // #477/#484: null-draft means the captain pane has no visible input box (an
  // overlay/menu/scrolled-away screen, #268) — delivery MUST keep deferring
  // forever (safe). stableCounts never accumulates on null content so the
  // stable-triggered probe path (#302) never fires either. Unlike a real or
  // ghost-shaped draft, an unconfirmed/unknown screen has no maxDefers escape
  // hatch: sendToSurface throws DeferDelivery(null) unconditionally regardless
  // of the probe flag (cmux.ts:633, checked before opts.probe is even read), so
  // probe escalation here would be dead code anyway — removing it (the #484 fix)
  // costs nothing for this case and keeps the "never deliver into an unknown
  // screen state" guarantee (#268) unconditional, not count-dependent.
  it("null-draft DeferDelivery never escalates to a probe, no matter how many defers (#477/#484)", async () => {
    const probes: boolean[] = [];
    const d = new CaptainDelivery({ maxDefers: 5, stableProbePolls: 3 });
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      if (!opts?.probe) throw new DeferDelivery(null);
    };
    for (let i = 0; i < 10; i++) await d.deliver({ seq: 1, message: "x" }, send);
    expect(probes.every((p) => !p)).toBe(true);
    // The stuck dashboard alarm still fires independently of probe escalation.
    expect(d.stats().stuck).toBe(true);
  });
});

describe("CaptainDelivery.stats (B1 — read-only deferral visibility)", () => {
  it("reports zero/not-stuck when nothing is in flight", () => {
    const d = new CaptainDelivery({ maxDefers: 5, stableProbePolls: 3 });
    expect(d.stats()).toEqual({ maxDeferCount: 0, stuck: false });
  });

  it("reports the max in-flight defer count across seqs, not stuck below the threshold", async () => {
    const d = new CaptainDelivery({ maxDefers: 5, stableProbePolls: 999 });
    const send = async () => { throw new DeferDelivery("draft"); };
    await d.deliver({ seq: 1, message: "a" }, send);
    await d.deliver({ seq: 1, message: "a" }, send);
    await d.deliver({ seq: 2, message: "b" }, send);
    expect(d.stats()).toEqual({ maxDeferCount: 2, stuck: false });
  });

  it("flags stuck once the max in-flight defer count reaches maxDefers", async () => {
    const d = new CaptainDelivery({ maxDefers: 2, stableProbePolls: 999 });
    const send = async () => { throw new DeferDelivery("draft"); };
    await d.deliver({ seq: 1, message: "a" }, send);
    await d.deliver({ seq: 1, message: "a" }, send);
    expect(d.stats()).toEqual({ maxDeferCount: 2, stuck: true });
  });

  it("clears a seq's defer count once it delivers", async () => {
    let fail = true;
    const d = new CaptainDelivery({ maxDefers: 5, stableProbePolls: 999 });
    const send = async () => { if (fail) throw new DeferDelivery("draft"); };
    await d.deliver({ seq: 1, message: "a" }, send);
    fail = false;
    await d.deliver({ seq: 1, message: "a" }, send);
    expect(d.stats()).toEqual({ maxDeferCount: 0, stuck: false });
  });
});
