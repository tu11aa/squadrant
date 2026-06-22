import { describe, it, expect } from "vitest";
import type { ControlEvent } from "@squadrant/shared";
import { topicName, formatLifecycle, formatInbound, maskToken } from "../format.js";

describe("topicName", () => {
  it("uses the project name as the topic title", () => {
    expect(topicName("squadrant")).toBe("squadrant");
  });
});

describe("formatLifecycle", () => {
  it("renders a task.done event", () => {
    const ev: ControlEvent = { type: "task.done", id: "abc123", resultRef: "/tmp/r", message: "shipped it" };
    expect(formatLifecycle("squadrant", ev)).toBe("✅ [squadrant] CREW DONE · abc123\nshipped it");
  });

  it("renders a task.done event without a message", () => {
    const ev: ControlEvent = { type: "task.done", id: "abc123", resultRef: "/tmp/r" };
    expect(formatLifecycle("squadrant", ev)).toBe("✅ [squadrant] CREW DONE · abc123");
  });

  it("renders a task.blocked event with its question", () => {
    const ev: ControlEvent = { type: "task.blocked", id: "def456", reason: "needs decision", question: "Which DB?" };
    expect(formatLifecycle("squadrant", ev)).toBe("🚧 [squadrant] CREW BLOCKED · def456\nWhich DB?");
  });

  it("renders a task.idle event", () => {
    const ev: ControlEvent = { type: "task.idle", id: "ghi789", heartbeatBudgetMs: 60000 };
    expect(formatLifecycle("squadrant", ev)).toBe("💤 [squadrant] CREW IDLE · ghi789");
  });

  it("falls back to a generic line for other event types (never throws)", () => {
    const ev: ControlEvent = { type: "task.failed", id: "xyz000", error: "boom" };
    expect(formatLifecycle("squadrant", ev)).toBe("ℹ️ [squadrant] task.failed · xyz000");
  });
});

describe("maskToken", () => {
  it("shows only the last 4 characters of a long token", () => {
    expect(maskToken("123456:ABCdefGHIJklm")).toBe("****************Jklm");
  });

  it("shows only the last 4 of a short token", () => {
    expect(maskToken("abc12345")).toBe("****2345");
  });

  it("returns the full token when 4 or fewer chars", () => {
    expect(maskToken("abcd")).toBe("abcd");
    expect(maskToken("a")).toBe("a");
  });

  it("handles empty string", () => {
    expect(maskToken("")).toBe("");
  });
});

describe("formatInbound", () => {
  it("labels a reply so the captain can tell it came from Telegram", () => {
    expect(formatInbound("ship it")).toBe("📩 [from Telegram] ship it");
  });
});
