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

  it("force-delivers (probe) after maxDefers regardless of stability", async () => {
    const probes: boolean[] = [];
    const d = new CaptainDelivery({ maxDefers: 2, stableProbePolls: 999 });
    let n = 0;
    const send = async (_t: string, opts?: { probe?: boolean }) => {
      probes.push(!!opts?.probe);
      if (!opts?.probe && n++ < 5) throw new DeferDelivery(`draft-${n}`);
    };
    for (let i = 0; i < 4; i++) await d.deliver({ seq: 9, message: "x" }, send);
    expect(probes.includes(true)).toBe(true);
  });

  it("returns { delivered: true } for null message (nothing to deliver)", async () => {
    const sent: string[] = [];
    const d = new CaptainDelivery({ maxDefers: 300, stableProbePolls: 3 });
    const result = await d.deliver({ seq: 99, message: null }, async (t) => { sent.push(t); });
    expect(result).toEqual({ delivered: true });
    expect(sent).toEqual([]);
  });
});
