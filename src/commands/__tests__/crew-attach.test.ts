import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  formatTurnHeader,
  formatTurnFooter,
  formatStatus,
  formatApproval,
  formatDoneFollowup,
  formatGatePromoted,
  formatConnectionLost,
  formatReattachFailed,
  computeBackoffDelay,
  isConnectionStable,
  STABLE_MS,
  RETRY_BUDGET_MS,
} from "../crew-attach.js";

describe("crew-attach formatters", () => {
  it("stripAnsi removes color codes but preserves text", () => {
    const colored = formatTurnHeader(1);
    const plain = stripAnsi(colored);
    expect(plain).toContain("codex");
    expect(plain).toContain("turn 1");
    expect(plain).not.toMatch(/\x1b\[/);
  });

  it("formatTurnHeader frames with rounded box-drawing chars", () => {
    const plain = stripAnsi(formatTurnHeader(3, 40));
    expect(plain.startsWith("╭─")).toBe(true);
    expect(plain.endsWith("╮")).toBe(true);
    expect(plain).toContain("turn 3");
  });

  it("formatTurnFooter shows elapsed seconds and closes box", () => {
    const plain = stripAnsi(formatTurnFooter(3200, 40));
    expect(plain.startsWith("╰─")).toBe(true);
    expect(plain.endsWith("╯")).toBe(true);
    expect(plain).toContain("3.2s");
  });

  it("formatStatus reports state, turn, and elapsed", () => {
    const plain = stripAnsi(formatStatus("working", 2, 1500));
    expect(plain).toContain("state=working");
    expect(plain).toContain("turn=2");
    expect(plain).toContain("elapsed=1.5s");
  });

  it("formatApproval includes kind and question", () => {
    const plain = stripAnsi(formatApproval("exec", "Run rm -rf?"));
    expect(plain).toContain("[approval] exec");
    expect(plain).toContain("Run rm -rf?");
  });

  it("dim helpers contain expected text", () => {
    expect(stripAnsi(formatDoneFollowup())).toContain("done — type a follow-up");
    expect(stripAnsi(formatGatePromoted("g-123"))).toContain("g-123");
  });

  it("formatConnectionLost contains retry message", () => {
    const plain = stripAnsi(formatConnectionLost());
    expect(plain).toContain("connection lost");
    expect(plain).toContain("retrying");
  });

  it("formatReattachFailed contains task id and re-run command", () => {
    const plain = stripAnsi(formatReattachFailed("task-abc-123"));
    expect(plain).toContain("reattach failed");
    expect(plain).toContain("cockpit crew attach task-abc-123");
  });
});

describe("crew-attach backoff logic", () => {
  it("computeBackoffDelay: attempt 0→1s, 1→2s, 2→4s, 3→8s, 4+→16s cap", () => {
    expect(computeBackoffDelay(0)).toBe(1_000);
    expect(computeBackoffDelay(1)).toBe(2_000);
    expect(computeBackoffDelay(2)).toBe(4_000);
    expect(computeBackoffDelay(3)).toBe(8_000);
    expect(computeBackoffDelay(4)).toBe(16_000);
    expect(computeBackoffDelay(5)).toBe(16_000);
    expect(computeBackoffDelay(10)).toBe(16_000);
  });

  it("isConnectionStable: not stable before STABLE_MS with no frames", () => {
    const t0 = 100_000;
    expect(isConnectionStable(t0, 0, t0 + STABLE_MS - 1)).toBe(false);
  });

  it("isConnectionStable: stable at exactly STABLE_MS with no frames", () => {
    const t0 = 100_000;
    expect(isConnectionStable(t0, 0, t0 + STABLE_MS)).toBe(true);
  });

  it("isConnectionStable: stable immediately with >=1 frame, regardless of elapsed time", () => {
    const t0 = 100_000;
    expect(isConnectionStable(t0, 1, t0 + 10)).toBe(true);
    expect(isConnectionStable(t0, 5, t0 + 1)).toBe(true);
  });

  it("flapping guard: 50ms immediate-close with no frames is NOT stable", () => {
    const t0 = 100_000;
    expect(isConnectionStable(t0, 0, t0 + 50)).toBe(false);
  });

  it("daemon-down guard: connectTimeMs=0 (never established) is NOT stable, even with huge elapsed", () => {
    // If 'connect' event never fires, connectTimeMs stays 0.
    // Date.now() - 0 is ~1.7e12 >> STABLE_MS, so without the connectTimeMs>0 guard
    // this would wrongly return true and reset backoff/budget every attempt.
    expect(isConnectionStable(0, 0, Date.now())).toBe(false);
    expect(isConnectionStable(0, 0, STABLE_MS * 1000)).toBe(false);
  });

  it("STABLE_MS is 5 seconds", () => {
    expect(STABLE_MS).toBe(5_000);
  });

  it("RETRY_BUDGET_MS is 60 seconds", () => {
    expect(RETRY_BUDGET_MS).toBe(60_000);
  });

  it("flapping: backoff grows on each unstable disconnect (no reset)", () => {
    // Simulate flapping: each connect closes immediately (unstable)
    // backoff should grow, not reset
    let attempt = 0;
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      delays.push(computeBackoffDelay(attempt));
      attempt += 1; // unstable → increment
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("stable-reset: backoff resets to 0 after a stable connection", () => {
    // Simulate: grow to attempt=3 via flapping, then get a stable connection
    let attempt = 3;
    // stable disconnect → reset to 0
    attempt = 0;
    // next flap → delay should be back to 1s
    expect(computeBackoffDelay(attempt)).toBe(1_000);
  });

  it("budget exhaustion: flapping from attempt 0 exceeds budget after 7 close events", () => {
    // Trace: delays are 1,2,4,8,16,16,16... (cap at 16s)
    // cumulative: 1,3,7,15,31,47,63 → exceeds 60s on 7th
    let attempt = 0;
    let total = 0;
    let closeCount = 0;
    while (true) {
      const delay = computeBackoffDelay(attempt);
      total += delay;
      closeCount += 1;
      if (total > RETRY_BUDGET_MS) break;
      attempt += 1; // unstable
    }
    expect(closeCount).toBe(7);
    expect(total).toBeGreaterThan(RETRY_BUDGET_MS);
  });
});
