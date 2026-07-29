import { describe, it, expect } from "vitest";
import {
  parseAssistantUsage,
  parseTranscriptLine,
  aggregateLines,
  buildRoleReport,
  escapeClaudeProjectPath,
  isCrewDirName,
  formatTokens,
  formatRange,
  mergeRanges,
} from "../tokens.js";

function assistantLine(
  usage: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>,
  timestamp?: string,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    },
  });
}

describe("parseAssistantUsage", () => {
  it("extracts the four token classes from a well-formed assistant line", () => {
    const usage = parseAssistantUsage(
      assistantLine({ input_tokens: 2, output_tokens: 70, cache_read_input_tokens: 17088, cache_creation_input_tokens: 34812 }),
    );
    expect(usage).toEqual({ input: 2, output: 70, cacheRead: 17088, cacheWrite: 34812 });
  });

  it("returns null for a user turn (no message.usage of interest)", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
    expect(parseAssistantUsage(line)).toBeNull();
  });

  it("returns null for an assistant message with no usage block", () => {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant" } });
    expect(parseAssistantUsage(line)).toBeNull();
  });

  it("returns null for unparsable JSON", () => {
    expect(parseAssistantUsage("{not json")).toBeNull();
  });

  it("returns null for a blank line", () => {
    expect(parseAssistantUsage("   ")).toBeNull();
  });
});

describe("aggregateLines", () => {
  it("sums the four token classes across assistant lines and ignores non-assistant lines", () => {
    const lines = [
      assistantLine({ input_tokens: 2, output_tokens: 70, cache_read_input_tokens: 17088, cache_creation_input_tokens: 34812 }),
      JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
      assistantLine({ input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 51900, cache_creation_input_tokens: 0 }),
    ];
    const agg = aggregateLines(lines);
    expect(agg.calls).toBe(2);
    expect(agg.input).toBe(7);
    expect(agg.output).toBe(100);
    expect(agg.cacheRead).toBe(17088 + 51900);
    expect(agg.cacheWrite).toBe(34812);
  });

  it("collapses consecutive retries (identical cache_read) into one turn but still counts every call", () => {
    const lines = [
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 17088, cache_creation_input_tokens: 34812 }), // turn 1
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 17088, cache_creation_input_tokens: 34812 }), // retry of turn 1
      assistantLine({ input_tokens: 3, cache_read_input_tokens: 51900, cache_creation_input_tokens: 0 }), // turn 2
    ];
    const agg = aggregateLines(lines);
    expect(agg.calls).toBe(3);
    expect(agg.turns).toHaveLength(2);
    expect(agg.turns[0]).toEqual({ total: 2 + 34812 + 17088, cacheRead: 17088 });
    expect(agg.turns[1]).toEqual({ total: 3 + 0 + 51900, cacheRead: 51900 });
  });

  it("reproduces the real-transcript invariant: turn-2 cache_read equals turn-1 total (boot confirmation)", () => {
    // Mirrors session 7b631cf9 from docs/specs/2026-07-28-captain-context-budget.md:
    // turn-1 total 51,902, turn-2 cache_read 51,900 (near-exact, confirms the boot prefix).
    const lines = [
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 17088, cache_creation_input_tokens: 34812 }), // total 51,902
      assistantLine({ input_tokens: 6, cache_read_input_tokens: 51900, cache_creation_input_tokens: 4997 }), // turn 2
    ];
    const agg = aggregateLines(lines);
    expect(agg.turns[0].total).toBe(51902);
    expect(agg.turns[1].cacheRead).toBe(51900);
  });
});

describe("parseTranscriptLine — timestamp extraction", () => {
  it("extracts the timestamp from an assistant line alongside usage", () => {
    const parsed = parseTranscriptLine(assistantLine({ input_tokens: 1 }, "2026-07-28T10:12:23.705Z"));
    expect(parsed.timestamp).toBe("2026-07-28T10:12:23.705Z");
    expect(parsed.usage).not.toBeNull();
  });

  it("extracts the timestamp from a non-assistant line even though usage is null", () => {
    const line = JSON.stringify({ type: "user", timestamp: "2026-06-29T00:00:00.000Z", message: { role: "user" } });
    const parsed = parseTranscriptLine(line);
    expect(parsed.timestamp).toBe("2026-06-29T00:00:00.000Z");
    expect(parsed.usage).toBeNull();
  });

  it("returns a null timestamp for line types that omit it (e.g. queue-operation)", () => {
    const line = JSON.stringify({ type: "queue-operation" });
    expect(parseTranscriptLine(line).timestamp).toBeNull();
  });
});

describe("aggregateLines — date range", () => {
  it("widens the session's [earliest, latest] from every line, not just assistant turns", () => {
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-06-29T00:00:00.000Z", message: { role: "user" } }),
      assistantLine({ input_tokens: 1 }, "2026-06-29T00:05:00.000Z"),
      assistantLine({ input_tokens: 1 }, "2026-07-29T12:00:00.000Z"),
    ];
    const agg = aggregateLines(lines);
    expect(agg.earliest).toBe("2026-06-29T00:00:00.000Z");
    expect(agg.latest).toBe("2026-07-29T12:00:00.000Z");
  });

  it("leaves the range null when no line has a timestamp", () => {
    const agg = aggregateLines([JSON.stringify({ type: "queue-operation" })]);
    expect(agg.earliest).toBeNull();
    expect(agg.latest).toBeNull();
  });
});

describe("mergeRanges / formatRange", () => {
  it("merges the widest earliest and latest across several ranges", () => {
    const merged = mergeRanges([
      { earliest: "2026-07-01T00:00:00.000Z", latest: "2026-07-10T00:00:00.000Z" },
      { earliest: "2026-06-29T00:00:00.000Z", latest: "2026-07-05T00:00:00.000Z" },
    ]);
    expect(merged.earliest).toBe("2026-06-29T00:00:00.000Z");
    expect(merged.latest).toBe("2026-07-10T00:00:00.000Z");
  });

  it("formats a range as YYYY-MM-DD → YYYY-MM-DD", () => {
    expect(
      formatRange({ earliest: "2026-06-29T00:00:00.000Z", latest: "2026-07-29T17:33:00.000Z" }),
    ).toBe("2026-06-29 → 2026-07-29");
  });

  it("reports 'no dated turns' rather than a misleading range when nothing has a timestamp", () => {
    expect(formatRange({ earliest: null, latest: null })).toBe("no dated turns");
  });
});

describe("escapeClaudeProjectPath / isCrewDirName", () => {
  it("replaces every non-alphanumeric character with '-'", () => {
    expect(escapeClaudeProjectPath("/Users/q3labsadmin/me/squadrant")).toBe("-Users-q3labsadmin-me-squadrant");
  });

  it("a worktree cwd escapes to '<captainSlug>--worktrees-<name>'", () => {
    const captain = escapeClaudeProjectPath("/Users/q3labsadmin/me/squadrant");
    const crew = escapeClaudeProjectPath("/Users/q3labsadmin/me/squadrant/.worktrees/squadrant-tokens-cmd");
    expect(crew).toBe(`${captain}--worktrees-squadrant-tokens-cmd`);
    expect(isCrewDirName(crew, captain)).toBe(true);
  });

  it("does not classify the captain's own dir as a crew", () => {
    const captain = escapeClaudeProjectPath("/Users/q3labsadmin/me/squadrant");
    expect(isCrewDirName(captain, captain)).toBe(false);
  });

  it("does not classify an unrelated project that merely shares a string prefix", () => {
    const captain = escapeClaudeProjectPath("/Users/q3labsadmin/me/app");
    const other = escapeClaudeProjectPath("/Users/q3labsadmin/me/app2");
    expect(isCrewDirName(other, captain)).toBe(false);
  });
});

describe("buildRoleReport", () => {
  it("computes mean boot, mean ctx/call, and accumulated split across sessions", () => {
    // Session A: boot 50,000 (turn 1), turn 2 confirms it (cache_read 50,000), one more turn at 150,000.
    const sessionA = aggregateLines([
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 50000 }),
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }),
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 150000, cache_creation_input_tokens: 0 }),
    ]);
    // Session B: boot 50,000 again, no second turn (short session).
    const sessionB = aggregateLines([
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 50000 }),
    ]);

    const report = buildRoleReport("captain", [sessionA, sessionB]);

    expect(report.sessionFiles).toBe(2);
    expect(report.calls).toBe(4);
    expect(report.meanBoot).toBe(50000); // both sessions boot at 50k
    expect(report.bootSampledSessions).toBe(2);
    expect(report.bootConfirmedSessions).toBe(1); // only session A had a turn-2 to confirm with
    expect(report.meanCacheReadPerCall).toBe((0 + 50000 + 150000 + 0) / 4);
    expect(report.accumulated).toBeCloseTo(report.meanCacheReadPerCall! - 50000);
  });

  it("returns nulls when no session has any turns", () => {
    const report = buildRoleReport("crews", []);
    expect(report.meanBoot).toBeNull();
    expect(report.meanCacheReadPerCall).toBeNull();
    expect(report.accumulated).toBeNull();
    expect(report.accumulatedPct).toBeNull();
  });

  it("rolls the date range up from sessions — this is what makes the rolling-window disclosure honest", () => {
    const sessionA = aggregateLines([assistantLine({ input_tokens: 1 }, "2026-06-29T00:00:00.000Z")]);
    const sessionB = aggregateLines([assistantLine({ input_tokens: 1 }, "2026-07-29T12:00:00.000Z")]);
    const report = buildRoleReport("captain", [sessionA, sessionB]);
    expect(report.earliest).toBe("2026-06-29T00:00:00.000Z");
    expect(report.latest).toBe("2026-07-29T12:00:00.000Z");
  });
});

describe("formatTokens", () => {
  it("formats millions with one decimal", () => {
    expect(formatTokens(1_457_000_000)).toBe("1457.0M");
    expect(formatTokens(1_300_000)).toBe("1.3M");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTokens(185_500)).toBe("185.5k");
  });

  it("formats small counts as a plain integer", () => {
    expect(formatTokens(70)).toBe("70");
  });
});
