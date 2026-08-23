import { describe, it, expect } from "vitest";
import { sanitizeSessionName, captainSessionName, crewSessionName } from "../lib/session-name.js";

describe("sanitizeSessionName", () => {
  it("passes safe names through unchanged", () => {
    expect(sanitizeSessionName("squadrant-captain-demo")).toBe("squadrant-captain-demo");
  });

  it("collapses unsafe characters to a single hyphen", () => {
    expect(sanitizeSessionName("a b/c!!d")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens produced by sanitizing", () => {
    expect(sanitizeSessionName("  leading and trailing  ")).toBe("leading-and-trailing");
  });

  it("caps length so a pathological name cannot grow unbounded", () => {
    expect(sanitizeSessionName("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("captainSessionName / crewSessionName (#708)", () => {
  it("ties a captain's name to its project", () => {
    expect(captainSessionName("squadrant")).toBe("squadrant-captain-squadrant");
  });

  it("ties a crew's name to its project and crew name — the exact case that misrouted a report", () => {
    // Real incident: a crew named only "fix-706" by cwd basename could not
    // tell itself apart from an unrelated "observer-sessions-53" session.
    expect(crewSessionName("squadrant", "fix-706")).toBe("squadrant-crew-squadrant-fix-706");
  });

  it("sanitizes project/crew names that are not already filesystem-safe", () => {
    expect(crewSessionName("my project", "task/one")).toBe("squadrant-crew-my-project-task-one");
  });
});
