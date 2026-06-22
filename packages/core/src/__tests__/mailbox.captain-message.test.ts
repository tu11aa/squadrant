import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCaptainMessage, readFromCursor, type MailboxEntry } from "../mailbox.js";
import { deliverable } from "../delivery/captain-delivery.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "mbox-cap-"));
}

async function collect(stateRoot: string, project: string): Promise<MailboxEntry[]> {
  const out: MailboxEntry[] = [];
  for await (const e of readFromCursor({ stateRoot, project, fromSeq: 1 })) out.push(e);
  return out;
}

describe("appendCaptainMessage", () => {
  it("writes a captain.message entry with the text as the message and seq=1", async () => {
    const stateRoot = freshState();
    await appendCaptainMessage({
      stateRoot,
      project: "demo",
      text: "📩 [from Telegram] ship it",
      source: "telegram",
    });

    const entries = await collect(stateRoot, "demo");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("captain.message");
    expect(entries[0].message).toBe("📩 [from Telegram] ship it");
    expect(entries[0].seq).toBe(1);
  });

  it("assigns monotonic seqs and yields entries in order via the captain cursor", async () => {
    const stateRoot = freshState();
    await appendCaptainMessage({ stateRoot, project: "demo", text: "first", source: "telegram" });
    await appendCaptainMessage({ stateRoot, project: "demo", text: "second", source: "telegram" });

    const entries = await collect(stateRoot, "demo");
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(entries.map((e) => e.message)).toEqual(["first", "second"]);
  });

  it("produces an entry that deliverable() will deliver (non-empty message)", async () => {
    const stateRoot = freshState();
    await appendCaptainMessage({ stateRoot, project: "demo", text: "steer left", source: "telegram" });

    const [entry] = await collect(stateRoot, "demo");
    expect(deliverable(entry)).toBe("steer left");
  });
});
