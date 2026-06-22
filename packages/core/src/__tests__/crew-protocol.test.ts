import { describe, it, expect } from "vitest";
import {
  isTurnAccepted,
  buildCompletionProtocol,
  shellQuote,
  titleFor,
  isCrewTitle,
  nameFromTitle,
  nextAutoName,
} from "../crew-protocol.js";

describe("isTurnAccepted", () => {
  it("returns true when screen changed (claude: no splashMarker)", () => {
    expect(isTurnAccepted("> ", "> do the thing")).toBe(true);
  });

  it("returns false when screen unchanged (claude)", () => {
    expect(isTurnAccepted("> ", "> ")).toBe(false);
  });

  it("returns true when opencode splash marker is absent from afterScreen", () => {
    expect(isTurnAccepted(
      "Ask anything…",
      "> do the thing",
      { splashMarker: "Ask anything…" },
    )).toBe(true);
  });

  it("returns false when opencode still at mutating splash (marker present)", () => {
    expect(isTurnAccepted(
      "Ask anything…",
      "Ask anything… ▊",
      { splashMarker: "Ask anything…" },
    )).toBe(false);
  });

  it("returns false when opencode splash marker present despite screen change", () => {
    expect(isTurnAccepted(
      "Ask anything…",
      "Ask anything… Build · DeepSeek… ▊",
      { splashMarker: "Ask anything…" },
    )).toBe(false);
  });

  it("returns true for opencode when splash marker absent even if afterScreen matches preSendScreen", () => {
    expect(isTurnAccepted(
      "Ask anything…",
      "> ready",
      { splashMarker: "Ask anything…" },
    )).toBe(true);
  });
});

describe("buildCompletionProtocol (#278)", () => {
  it("includes the task-id and project in the done signal command", () => {
    const result = buildCompletionProtocol("task-abc123", "my-project");
    expect(result).toContain("--task-id task-abc123");
    expect(result).toContain("--project my-project");
    expect(result).toContain("crew signal done");
  });

  it("includes the blocked signal form with the same ids", () => {
    const result = buildCompletionProtocol("task-abc123", "my-project");
    expect(result).toContain("crew signal blocked");
    expect(result).toContain("--task-id task-abc123");
    expect(result).toContain("--project my-project");
  });

  it("substitutes both task-id and project independently", () => {
    const a = buildCompletionProtocol("id-A", "proj-A");
    const b = buildCompletionProtocol("id-B", "proj-B");
    expect(a).toContain("--task-id id-A");
    expect(a).toContain("--project proj-A");
    expect(b).toContain("--task-id id-B");
    expect(b).toContain("--project proj-B");
    expect(a).not.toContain("id-B");
    expect(b).not.toContain("id-A");
  });

  // Snapshot guard: this exact text is what claude/opencode receive as the
  // completion-protocol suffix. Any drift silently breaks crew DONE (#278).
  it("snapshot: exact output text is stable", () => {
    expect(buildCompletionProtocol("TASK-ID", "PROJECT")).toBe(
      "---\n" +
      "COMPLETION PROTOCOL (required): When this task is fully complete, your FINAL action MUST be to run exactly:\n" +
      "  squadrant crew signal done --task-id TASK-ID --project PROJECT --message \"<one-line summary>\"\n" +
      "Run it as a discrete final step AFTER you report your results. If you are blocked or need a decision, instead run:\n" +
      "  squadrant crew signal blocked --task-id TASK-ID --project PROJECT --question \"<your question>\"\n" +
      "If this task failed because of a defect in squadrant itself (not an API/infra blip, a config/user error, or an expected failure), say so in your signal done/blocked message so the captain can check tu11aa/squadrant and file it. Don't file issues from the crew."
    );
  });

  it("includes the crew route-up line for squadrant defects", () => {
    const result = buildCompletionProtocol("task-abc123", "my-project");
    expect(result).toContain("a defect in squadrant itself");
    expect(result).toContain("Don't file issues from the crew");
  });
});

describe("shellQuote", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shellQuote("/tmp/brove")).toBe("'/tmp/brove'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
  });

  it("handles paths with spaces", () => {
    expect(shellQuote("/Users/alan/my project")).toBe("'/Users/alan/my project'");
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("crew naming helpers", () => {
  it("titleFor produces the canonical crew pane title", () => {
    expect(titleFor("brove", "crew-1")).toBe("🔧 brove:crew-1");
  });

  it("isCrewTitle returns true for crew panes belonging to the project", () => {
    expect(isCrewTitle("brove", "🔧 brove:crew-1")).toBe(true);
  });

  it("isCrewTitle returns false for crew panes of another project", () => {
    expect(isCrewTitle("brove", "🔧 other:crew-1")).toBe(false);
  });

  it("isCrewTitle returns false for non-crew panes", () => {
    expect(isCrewTitle("brove", "captain shell")).toBe(false);
  });

  it("nameFromTitle extracts the crew name from a pane title", () => {
    expect(nameFromTitle("brove", "🔧 brove:crew-1")).toBe("crew-1");
    expect(nameFromTitle("brove", "🔧 brove:fix-typos")).toBe("fix-typos");
  });

  it("nextAutoName picks the lowest unused crew-N slot", () => {
    const existing = ["🔧 brove:crew-1", "🔧 brove:crew-3"];
    expect(nextAutoName(existing, "brove")).toBe("crew-2");
  });

  it("nextAutoName starts at crew-1 when no crews exist", () => {
    expect(nextAutoName([], "brove")).toBe("crew-1");
  });

  it("nextAutoName picks crew-4 when 1-3 are taken", () => {
    const existing = ["🔧 brove:crew-1", "🔧 brove:crew-2", "🔧 brove:crew-3"];
    expect(nextAutoName(existing, "brove")).toBe("crew-4");
  });

  it("nextAutoName ignores non-numbered crew names", () => {
    const existing = ["🔧 brove:fix-typos", "🔧 brove:crew-2"];
    expect(nextAutoName(existing, "brove")).toBe("crew-1");
  });
});
