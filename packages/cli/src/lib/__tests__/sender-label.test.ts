import { describe, it, expect } from "vitest";
import { senderLabel } from "../sender-label.js";

const L = (env: Record<string, string>, project: string | null = "app", taskName?: string) =>
  senderLabel({ env, currentProject: () => project, taskName: () => taskName });

describe("senderLabel (#1029: ping / runtime send identity)", () => {
  it("a plain terminal — even inside a project directory — is cli", () => {
    expect(L({})).toBe("cli");
    expect(L({}, null)).toBe("cli");
  });
  it("the captain session (SQUADRANT_ROLE=captain) is captain:<project>; with no resolvable project it is cli", () => {
    expect(L({ SQUADRANT_ROLE: "captain" })).toBe("captain:app");
    expect(L({ SQUADRANT_ROLE: "captain" }, null)).toBe("cli");
  });
  it("a crew is crew:<project>/<name> (short task id when the name is unknown), never the captain", () => {
    const env = { SQUADRANT_CREW_TASK_ID: "ef2630e1-aaaa", SQUADRANT_CREW_PROJECT: "flooros", SQUADRANT_ROLE: "captain" };
    expect(L(env, "app", "sync-242b")).toBe("crew:flooros/sync-242b");
    expect(L(env, "app")).toBe("crew:flooros/ef2630e1");
  });
  it("thread and side tabs use their own labels", () => {
    expect(L({ SQUADRANT_ROLE: "thread", SQUADRANT_THREAD_ID: "auth-cache" })).toBe("thread:auth-cache");
    expect(L({ SQUADRANT_SIDE_SESSION: "1" })).toBe("side");
  });
});
