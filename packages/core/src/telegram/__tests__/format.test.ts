import { describe, it, expect } from "vitest";
import type { ControlEvent } from "@squadrant/shared";
import {
  topicName,
  formatLifecycle,
  formatInbound,
  formatMediaReceipt,
  inboundBody,
  maskToken,
  mediaKind,
  mediaMarker,
  formatUsageLine,
} from "../format.js";
import type { ProjectUsage } from "../../router/usage-ledger.js";

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

  it("renders a task.review event with its message (#599)", () => {
    const ev: ControlEvent = { type: "task.review", id: "rev1", message: "ready for review" };
    expect(formatLifecycle("squadrant", ev)).toBe("👀 [squadrant] CREW REVIEW · rev1\nready for review");
  });

  it("renders a task.review event without a message", () => {
    const ev: ControlEvent = { type: "task.review", id: "rev2" };
    expect(formatLifecycle("squadrant", ev)).toBe("👀 [squadrant] CREW REVIEW · rev2");
  });

  it("renders a task.idle event", () => {
    const ev: ControlEvent = { type: "task.idle", id: "ghi789", heartbeatBudgetMs: 60000 };
    expect(formatLifecycle("squadrant", ev)).toBe("💤 [squadrant] CREW IDLE · ghi789");
  });

  it("falls back to a generic line for other event types (never throws)", () => {
    const ev: ControlEvent = { type: "task.progress", id: "xyz000", note: "still going" };
    expect(formatLifecycle("squadrant", ev)).toBe("ℹ️ [squadrant] task.progress · xyz000");
  });
});

describe("formatLifecycle new cases", () => {
  it("failed shows the error", () => {
    const s = formatLifecycle("p", { type: "task.failed", id: "t1", error: "boom" } as any);
    expect(s).toContain("CREW FAILED");
    expect(s).toContain("boom");
  });
  it("approval shows the question", () => {
    const s = formatLifecycle("p", { type: "task.approval.requested", id: "t1", requestId: 1, question: "run rm?", kind: "shell" } as any);
    expect(s).toContain("APPROVAL");
    expect(s).toContain("run rm?");
  });
  it("input shows the question", () => {
    const s = formatLifecycle("p", { type: "task.input.requested", id: "t1", requestId: 1, question: "which env?" } as any);
    expect(s).toContain("INPUT");
    expect(s).toContain("which env?");
  });
  it("timeout shows a timeout line", () => {
    const s = formatLifecycle("p", { type: "task.timeout", id: "t1", taskTimeoutMs: 1000 } as any);
    expect(s).toContain("CREW TIMEOUT");
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

describe("mediaKind / mediaMarker / inboundBody / formatMediaReceipt (#768)", () => {
  it("names each attachment Telegram can send", () => {
    expect(mediaKind({ photo: [{}] })).toBe("photo");
    expect(mediaKind({ document: {} })).toBe("document");
    expect(mediaKind({ voice: {} })).toBe("voice message");
    expect(mediaKind({ video_note: {} })).toBe("video message");
    expect(mediaKind({ video: {} })).toBe("video");
    expect(mediaKind({ audio: {} })).toBe("audio file");
    expect(mediaKind({ animation: {} })).toBe("animation");
    expect(mediaKind({ sticker: {} })).toBe("sticker");
  });

  it("returns undefined for a plain text message", () => {
    expect(mediaKind({})).toBeUndefined();
    expect(mediaKind({ photo: undefined })).toBeUndefined();
  });

  it("renders the marker with the kind it was given", () => {
    expect(mediaMarker("photo")).toBe("[photo attached - not forwarded]");
    expect(mediaMarker("voice message")).toBe("[voice message attached - not forwarded]");
  });

  it("appends the marker below the caption so the caption reads as the message", () => {
    expect(inboundBody("look at this", "photo")).toBe("look at this\n[photo attached - not forwarded]");
  });

  it("uses the marker alone when the media carried no caption", () => {
    expect(inboundBody(undefined, "sticker")).toBe("[sticker attached - not forwarded]");
  });

  it("passes text through untouched when no media accompanied it", () => {
    expect(inboundBody("ship it", undefined)).toBe("ship it");
  });

  it("tells the operator the attachment did not reach the captain", () => {
    expect(formatMediaReceipt("photo", true)).toBe("📎 photo not forwarded — your caption reached the captain");
    expect(formatMediaReceipt("voice message", false))
      .toBe("📎 voice message not forwarded — the captain was told it arrived, nothing else was sent");
  });
});

describe("formatUsageLine", () => {
  const models = (entries: Record<string, { requests: number; costUsd: number }>): ProjectUsage["models"] =>
    Object.fromEntries(
      Object.entries(entries).map(([m, v]) => [m, { ...v, inputTokens: 0, outputTokens: 0 }]),
    );

  it("renders cost, request count and the top model by cost", () => {
    const u: ProjectUsage = {
      project: "p", requests: 3, costUsd: 0.0123,
      models: models({ "m-a": { requests: 2, costUsd: 0.01 }, "m-b": { requests: 1, costUsd: 0.0023 } }),
    };
    expect(formatUsageLine(u)).toBe("💰 $0.0123 · 3 reqs · m-a +1");
  });

  it("names the top model and counts the rest", () => {
    const u: ProjectUsage = {
      project: "p", requests: 6, costUsd: 0.06,
      models: models({
        "m-a": { requests: 2, costUsd: 0.01 },
        "m-b": { requests: 2, costUsd: 0.02 },
        "m-c": { requests: 2, costUsd: 0.03 },
      }),
    };
    expect(formatUsageLine(u)).toBe("💰 $0.0600 · 6 reqs · m-c +2");
  });

  it("omits the model suffix when every request is unattributed", () => {
    const u: ProjectUsage = { project: "p", requests: 1, costUsd: 0.001, models: models({ unknown: { requests: 1, costUsd: 0.001 } }) };
    expect(formatUsageLine(u)).toBe("💰 $0.0010 · 1 req");
  });

  it("singularises one request", () => {
    const u: ProjectUsage = { project: "p", requests: 1, costUsd: 0.5, models: models({ m: { requests: 1, costUsd: 0.5 } }) };
    expect(formatUsageLine(u)).toBe("💰 $0.5000 · 1 req · m");
  });
});
