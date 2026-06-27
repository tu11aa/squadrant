import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  partitionByYesterday,
  getYesterday,
  selectCaptainsInteractive,
  type CaptainEntry,
} from "../launch-interactive.js";

const MOCK_ENTRIES: CaptainEntry[] = [
  { projectName: "squadrant", captainName: "⚓ squadrant-captain", lastLaunched: "2026-06-26" },
  { projectName: "brove", captainName: "⚓ brove-captain", lastLaunched: "2026-06-26" },
  { projectName: "oneplan", captainName: "⚓ oneplan-captain", lastLaunched: "2026-06-25" },
  { projectName: "park", captainName: "⚓ park-captain", lastLaunched: null },
];

describe("getYesterday", () => {
  it("returns yesterday's date in YYYY-MM-DD format", () => {
    const yesterday = getYesterday();
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const d = new Date();
    d.setDate(d.getDate() - 1);
    expect(yesterday).toBe(d.toISOString().slice(0, 10));
  });
});

describe("partitionByYesterday", () => {
  it("separates yesterday-launched entries from the rest", () => {
    const result = partitionByYesterday(MOCK_ENTRIES, "2026-06-26");
    expect(result.yesterday).toEqual([
      { projectName: "squadrant", captainName: "⚓ squadrant-captain", lastLaunched: "2026-06-26" },
      { projectName: "brove", captainName: "⚓ brove-captain", lastLaunched: "2026-06-26" },
    ]);
    expect(result.rest).toEqual([
      { projectName: "oneplan", captainName: "⚓ oneplan-captain", lastLaunched: "2026-06-25" },
      { projectName: "park", captainName: "⚓ park-captain", lastLaunched: null },
    ]);
  });

  it("returns empty yesterday array when none match", () => {
    const result = partitionByYesterday(MOCK_ENTRIES, "2099-01-01");
    expect(result.yesterday).toEqual([]);
    expect(result.rest).toEqual(MOCK_ENTRIES);
  });

  it("returns empty rest array when all match", () => {
    const allYesterday = MOCK_ENTRIES.map(e => ({ ...e, lastLaunched: "2026-06-26" }));
    const result = partitionByYesterday(allYesterday, "2026-06-26");
    expect(result.yesterday).toEqual(allYesterday);
    expect(result.rest).toEqual([]);
  });
});

describe("selectCaptainsInteractive", () => {
  const mockCheckbox = vi.hoisted(() => vi.fn());
  vi.mock("@inquirer/checkbox", () => {
    class Separator {
      separator: string;
      constructor(separator: string) { this.separator = separator; }
      toString() { return this.separator; }
    }
    const mod = mockCheckbox as typeof mockCheckbox & { Separator: typeof Separator };
    mod.Separator = Separator;
    return { default: mod, Separator };
  });

  beforeEach(() => {
    mockCheckbox.mockReset();
  });

  it("shows yesterday's captains pre-checked and returns selection", async () => {
    const yesterdayEntries = MOCK_ENTRIES.filter(e => e.lastLaunched === "2026-06-26");
    mockCheckbox.mockResolvedValue(["squadrant"]);

    const result = await selectCaptainsInteractive(MOCK_ENTRIES);

    expect(result).toEqual(["squadrant"]);

    // Verify the checkbox was called with yesterday's entries pre-checked + "Show all"
    const callArgs = mockCheckbox.mock.calls[0][0];
    expect(callArgs.message).toContain("Select captains to launch");
    const choices = callArgs.choices;
    // The "Show all" entry is present
    expect(choices.some((c: { value: string }) => c.value === "__show_all__")).toBe(true);
    // Each yesterday entry is pre-checked
    for (const y of yesterdayEntries) {
      const choice = choices.find((c: { value: string }) => c.value === y.projectName);
      expect(choice).toBeDefined();
      expect(choice.checked).toBe(true);
    }
  });

  it("re-prompts with all projects when Show all is selected", async () => {
    // First call: user selects "brove" + "__show_all__"
    // Second call: user selects "brove" + "park"
    mockCheckbox
      .mockResolvedValueOnce(["brove", "__show_all__"])
      .mockResolvedValueOnce(["brove", "park"]);

    const result = await selectCaptainsInteractive(MOCK_ENTRIES);

    expect(result).toEqual(["brove", "park"]);
    expect(mockCheckbox).toHaveBeenCalledTimes(2);

    // Second call should have ALL projects listed
    const secondCallChoices = mockCheckbox.mock.calls[1][0].choices;
    for (const e of MOCK_ENTRIES) {
      expect(secondCallChoices.some((c: { value: string }) => c.value === e.projectName)).toBe(true);
    }
  });

  it("shows all projects unchecked when none were launched yesterday", async () => {
    mockCheckbox.mockResolvedValue(["oneplan", "park"]);

    const entriesWithoutYesterday = MOCK_ENTRIES.map(e => ({ ...e, lastLaunched: null }));
    const result = await selectCaptainsInteractive(entriesWithoutYesterday);

    expect(result).toEqual(["oneplan", "park"]);

    // All non-separator choices should be unchecked
    const choices = mockCheckbox.mock.calls[0][0].choices.filter((c: { value?: string }) => c.value);
    for (const c of choices) {
      expect(c.checked).toBe(false);
    }
    // No "Show all" option when showing everything already
    const values = choices.map((c: { value: string }) => c.value);
    expect(values).not.toContain("__show_all__");
  });

  it("shows yesterday's captains pre-checked when all launched yesterday", async () => {
    const allYesterday = MOCK_ENTRIES.map(e => ({ ...e, lastLaunched: "2026-06-26" }));
    mockCheckbox.mockResolvedValue(["squadrant", "brove"]);

    const result = await selectCaptainsInteractive(allYesterday);

    expect(result).toEqual(["squadrant", "brove"]);

    // Choices should include all entries pre-checked + "Show all"
    const choices = mockCheckbox.mock.calls[0][0].choices.filter((c: { value?: string }) => c.value);
    const values = choices.map((c: { value: string }) => c.value);
    expect(values).toContain("__show_all__");
    for (const c of choices.filter((c: { value: string }) => c.value !== "__show_all__")) {
      expect(c.checked).toBe(true);
    }
  });
});
