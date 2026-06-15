// src/control/__tests__/mailbox-captain-message.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendCaptainMessage, readFromCursor } from "../mailbox.js";

describe("appendCaptainMessage", () => {
  it("appends a deliverable captain.message entry with a monotonic seq", async () => {
    const root = mkdtempSync(join(tmpdir(), "mbox-"));
    const seq1 = await appendCaptainMessage({ stateRoot: root, project: "cockpit", message: "hello", taskId: "t1", name: "crew-1" });
    const seq2 = await appendCaptainMessage({ stateRoot: root, project: "cockpit", message: "again" });
    expect(seq2).toBe(seq1 + 1);

    const entries = [];
    for await (const e of readFromCursor({ stateRoot: root, project: "cockpit", fromSeq: 1 })) entries.push(e);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("captain.message");
    expect(entries[0].message).toBe("hello");
    expect(entries[0].name).toBe("crew-1");
    expect(entries[1].taskId).toBe("captain");
  });
});
