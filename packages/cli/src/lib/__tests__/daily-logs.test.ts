import { describe, it, expect } from "vitest";
import { readDailyLog, parseSection } from "@squadrant/shared";
import { createMemoryDriver } from "../../../../workspaces/src/workspaces/__tests__/helpers/memory-driver.js";

describe("readDailyLog", () => {
  it("returns null when the daily log does not exist", async () => {
    const ws = createMemoryDriver();
    const log = await readDailyLog(ws, "2026-04-21");
    expect(log).toBeNull();
  });

  it("parses content and extracts blockers", async () => {
    const ws = createMemoryDriver({
      "daily-logs/2026-04-21.md": `---\ndate: 2026-04-21\n---\n\n## Completed\n- shipped phase 1\n\n## Blocked\n- waiting on code review\n- needs approval\n`,
    });
    const log = await readDailyLog(ws, "2026-04-21");
    expect(log).not.toBeNull();
    expect(log!.blockers).toEqual(["waiting on code review", "needs approval"]);
  });

  it("returns empty blockers when Blocked section is (none)", async () => {
    const ws = createMemoryDriver({
      "daily-logs/2026-04-21.md": `## Blocked\n- (none)\n`,
    });
    const log = await readDailyLog(ws, "2026-04-21");
    expect(log!.blockers).toEqual([]);
  });
});

describe("parseSection", () => {
  it("extracts list items from a named section", () => {
    const content = `## Completed\n- a\n- b\n\n## Other\n- c`;
    expect(parseSection(content, "Completed")).toEqual(["a", "b"]);
  });
});
