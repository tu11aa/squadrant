import { describe, it, expect } from "vitest";
import { LivenessRegistry } from "../liveness-registry.js";
import type { LivenessEntry } from "@squadrant/shared";

function memFs() {
  const store = new Map<string, string>();
  return {
    store,
    readFile: (p: string) => store.get(p),
    writeFile: (p: string, c: string) => void store.set(p, c),
  };
}
const cap = (o: Partial<LivenessEntry> = {}): LivenessEntry => ({
  project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000,
  lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime", ...o,
});

describe("LivenessRegistry", () => {
  it("persists and reloads across a simulated restart", () => {
    const fs = memFs();
    const r1 = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r1.apply(cap());
    const r2 = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r2.load();
    expect(r2.get("p")?.pid).toBe(100);
  });
  it("markEnded keeps the entry (→ stopped, not forgotten)", () => {
    const fs = memFs();
    const r = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r.apply(cap());
    r.markEnded("p", 2_000);
    expect(r.get("p")?.lastState).toBe("end");
  });
  it("setPidAlive updates liveness only", () => {
    const fs = memFs();
    const r = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r.apply(cap());
    r.setPidAlive("p", false, 2_000);
    expect(r.get("p")?.pidAlive).toBe(false);
    expect(r.get("p")?.lastState).toBe("start");
  });
  it("corrupt file loads as empty (no throw)", () => {
    const fs = memFs(); fs.store.set("/x/liveness.json", "{not json");
    const r = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    expect(() => r.load()).not.toThrow();
    expect(r.all()).toEqual([]);
  });
});
