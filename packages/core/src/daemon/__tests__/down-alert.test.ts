// #744: the boot-gap alert must be self-describing (a real outage window,
// not just a bare minute count) and must flag itself as stale when delivery
// happens long after generation, so a days-late mailbox entry doesn't read
// as a current outage.
import { describe, it, expect } from "vitest";
import { formatDownAlertText, stalePrefix, STALE_ALERT_THRESHOLD_MS } from "../down-alert.js";

describe("formatDownAlertText (#744a)", () => {
  it("bakes the outage window, minute count, and tz offset into the text", () => {
    // Fix the environment's tz to +07 for a deterministic offset string.
    const prevTz = process.env.TZ;
    process.env.TZ = "Asia/Bangkok";
    try {
      const text = formatDownAlertText({
        startTs: "2026-09-02T16:16:00.000Z", // 23:16 +07
        endTs: "2026-09-02T23:25:00.000Z", // 06:25 +07 next day
        minutes: 429,
        reasonText: "SIGTERM",
      });
      expect(text).toBe(
        "⚠️ daemon was down 2026-09-02 23:16 → 2026-09-03 06:25 (+07), 429 min (last exit reason=SIGTERM)",
      );
    } finally {
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
  });
});

describe("stalePrefix (#744b)", () => {
  it("returns null when delivered within the threshold of generation", () => {
    const generatedAtMs = 1_000_000;
    expect(stalePrefix(generatedAtMs, generatedAtMs + STALE_ALERT_THRESHOLD_MS)).toBeNull();
    expect(stalePrefix(generatedAtMs, generatedAtMs + 5 * 60_000)).toBeNull();
  });

  it("returns a relative-age prefix once delivery is more than 1h after generation", () => {
    const generatedAtMs = 1_000_000;
    const prefix = stalePrefix(generatedAtMs, generatedAtMs + STALE_ALERT_THRESHOLD_MS + 60_000);
    expect(prefix).toBe("[stale — generated 1h 1m ago] ");
  });

  it("formats a multi-day age in days+hours", () => {
    const generatedAtMs = 0;
    const twoDaysSevenHoursMs = (2 * 24 + 7) * 60 * 60 * 1000;
    const prefix = stalePrefix(generatedAtMs, twoDaysSevenHoursMs);
    expect(prefix).toBe("[stale — generated 2d 7h ago] ");
  });
});
