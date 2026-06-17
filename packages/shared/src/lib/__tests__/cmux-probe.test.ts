import { describe, it, expect } from "vitest";
import { classifyProbe, probeCmuxDaemonDirect } from "../cmux-probe.js";

describe("classifyProbe", () => {
  it("ok=true → reachable", () => {
    expect(classifyProbe({ ok: true })).toBe("reachable");
  });

  it("access-denied stderr → denied", () => {
    expect(classifyProbe({ ok: false, stderr: "Access denied" })).toBe("denied");
    expect(
      classifyProbe({ ok: false, stderr: "only processes started inside cmux may connect" }),
    ).toBe("denied");
    expect(classifyProbe({ ok: false, stderr: "permission denied (socket)" })).toBe("denied");
  });

  it("other failures → unknown (fail-soft, stay on relay)", () => {
    expect(classifyProbe({ ok: false, stderr: "cmux: command not found" })).toBe("unknown");
    expect(classifyProbe({ ok: false, stderr: "orphan-timeout" })).toBe("unknown");
    expect(classifyProbe({ ok: false })).toBe("unknown");
  });
});

describe("probeCmuxDaemonDirect", () => {
  it("returns the classified verdict from the injected runner", async () => {
    expect(await probeCmuxDaemonDirect({ run: async () => ({ ok: true }) })).toBe("reachable");
    expect(
      await probeCmuxDaemonDirect({ run: async () => ({ ok: false, stderr: "Access denied" }) }),
    ).toBe("denied");
    expect(
      await probeCmuxDaemonDirect({ run: async () => ({ ok: false, stderr: "boom" }) }),
    ).toBe("unknown");
  });

  it("maps a thrown runner to unknown (never throws to the caller)", async () => {
    const verdict = await probeCmuxDaemonDirect({
      run: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(verdict).toBe("unknown");
  });
});
