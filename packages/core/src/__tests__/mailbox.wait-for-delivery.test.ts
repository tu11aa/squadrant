import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCaptainMessage, waitForCaptainDelivery, writeCursor } from "../mailbox.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "mbox-wait-"));
}

// #566 bug (b): runtime send/ping route through the mailbox (#529) but never
// confirmed the delivery loop actually drained the entry — the CLI reported
// success the instant the append landed on disk, regardless of whether a
// captain was ever there to receive it. waitForCaptainDelivery lets the CLI
// poll the delivery cursor and find out for certain.
describe("appendCaptainMessage", () => {
  it("returns the assigned seq so callers can confirm delivery", async () => {
    const stateRoot = freshState();
    const seq = await appendCaptainMessage({ stateRoot, project: "demo", text: "hi", source: "cli" });
    expect(seq).toBe(1);
  });
});

describe("waitForCaptainDelivery", () => {
  it("resolves true once the delivery cursor advances past the given seq", async () => {
    const stateRoot = freshState();
    const seq = await appendCaptainMessage({ stateRoot, project: "demo", text: "hi", source: "cli" });

    // Simulate the delivery loop acking the entry shortly after the append.
    setTimeout(() => {
      writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: seq });
    }, 30);

    const delivered = await waitForCaptainDelivery({
      stateRoot,
      project: "demo",
      seq,
      timeoutMs: 2000,
      pollMs: 10,
    });
    expect(delivered).toBe(true);
  });

  it("resolves false when the cursor never advances within the timeout (#565-class: captain unreachable/reaped)", async () => {
    const stateRoot = freshState();
    const seq = await appendCaptainMessage({ stateRoot, project: "demo", text: "hi", source: "cli" });

    const delivered = await waitForCaptainDelivery({
      stateRoot,
      project: "demo",
      seq,
      timeoutMs: 100,
      pollMs: 10,
    });
    expect(delivered).toBe(false);
  });

  it("resolves true immediately when the cursor already covers an earlier seq", async () => {
    const stateRoot = freshState();
    const seq1 = await appendCaptainMessage({ stateRoot, project: "demo", text: "first", source: "cli" });
    await appendCaptainMessage({ stateRoot, project: "demo", text: "second", source: "cli" });
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: seq1 + 1 });

    const delivered = await waitForCaptainDelivery({
      stateRoot,
      project: "demo",
      seq: seq1,
      timeoutMs: 2000,
      pollMs: 10,
    });
    expect(delivered).toBe(true);
  });
});
