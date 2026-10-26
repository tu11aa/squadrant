import { describe, it, expect } from "vitest";
import type { TaskRecord } from "@squadrant/shared";
import { decodeCmuxSessionId, resolveHookTask } from "../cmux-hook-attribution.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const feed = (id: string) => `cmux-feed-v1:${b64("claude")}:${b64(id)}`;
const CWD = "/wt/crew";
const crew = { id: "t1", mode: "interactive", state: "working", cwd: CWD, sessionId: "crew-sess" } as TaskRecord;

describe("resolveHookTask", () => {
  it("decodes the cmux feed session id, and passes a bare id through", () => {
    expect(decodeCmuxSessionId(feed("abc"))).toBe("abc");
    expect(decodeCmuxSessionId("abc")).toBe("abc");
    expect(decodeCmuxSessionId(undefined)).toBeUndefined();
  });
  it("attributes the crew's own session", () => {
    expect(resolveHookTask([crew], { cwd: CWD, sessionId: feed("crew-sess") })?.id).toBe("t1");
  });
  it("does not attribute a captain session that cd'd into the crew's worktree", () => {
    expect(resolveHookTask([crew], { cwd: CWD, sessionId: feed("captain-sess") })).toBeUndefined();
  });
  it("does not match a task whose session cannot be resolved", () => {
    const unknown = { ...crew, sessionId: undefined } as TaskRecord;
    expect(resolveHookTask([unknown], { cwd: CWD, sessionId: feed("captain-sess") }, () => undefined)).toBeUndefined();
  });
  it("falls back to the registry session when the record has none", () => {
    const rec = { ...crew, sessionId: undefined } as TaskRecord;
    expect(resolveHookTask([rec], { cwd: CWD, sessionId: feed("crew-sess") }, () => "crew-sess")?.id).toBe("t1");
  });
  it("falls back to cwd only when the frame has no session id", () => {
    expect(resolveHookTask([crew], { cwd: CWD })?.id).toBe("t1");
  });
  it("ignores terminal, headless and other-cwd tasks", () => {
    const done = { ...crew, state: "done" } as TaskRecord;
    expect(resolveHookTask([done], { cwd: CWD, sessionId: feed("crew-sess") })).toBeUndefined();
    expect(resolveHookTask([crew], { cwd: "/elsewhere", sessionId: feed("crew-sess") })).toBeUndefined();
  });
});
