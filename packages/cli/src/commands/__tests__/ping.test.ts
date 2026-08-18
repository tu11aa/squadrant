import { describe, it, expect, vi } from "vitest";
import { formatPingResult } from "../ping.js";

describe("formatPingResult (#667 slice 4)", () => {
  it("keeps the legacy line when the channel was not used", () => {
    expect(formatPingResult("demo", undefined)).toBe("✔ Pinged 'demo'");
  });

  it("reports a confirmed accept as delivered, not merely pinged", () => {
    expect(formatPingResult("demo", { status: "accepted", via: "claude-peer", confirmed: true }))
      .toBe("✔ Delivered to 'demo' (accepted via claude-peer)");
  });

  it("does not claim delivery for an unconfirmed accept", () => {
    expect(formatPingResult("demo", { status: "accepted", via: "claude-peer", confirmed: false }))
      .toBe("✔ Sent to 'demo' (accepted via claude-peer (unconfirmed — no turn observed))");
  });

  it("says held, and says a human must act", () => {
    expect(formatPingResult("demo", { status: "held", via: "claude-peer", reason: "parity" }))
      .toBe("⏸ Held for 'demo' — awaiting approval in that session: parity");
  });

  it("says gone — evidence the captain is dead, replacing a screen read", () => {
    expect(formatPingResult("demo", { status: "gone" }))
      .toBe("⚠ Captain for 'demo' is not reachable — fell back to its pane mailbox");
  });
});
