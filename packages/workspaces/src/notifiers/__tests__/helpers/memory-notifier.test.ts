import { describe, it, expect } from "vitest";
import { createMemoryNotifier } from "./memory-notifier.js";

describe("createMemoryNotifier", () => {
  it("records notified messages in order", async () => {
    const n = createMemoryNotifier();
    await n.notify("first");
    await n.notify("second");
    expect(n.messages).toEqual(["first", "second"]);
  });

  it("probe returns installed+reachable=true", async () => {
    const n = createMemoryNotifier();
    expect(await n.probe()).toEqual({ installed: true, reachable: true });
  });
});
