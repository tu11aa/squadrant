import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";
import { readProjectDailyLog } from "../project-daily-log.js";

// #983: daily logs moved to workspace/<p>/artifacts/daily-logs/; the spoke is read for one version.
describe("readProjectDailyLog (#983)", () => {
  let tmp: string;
  let config: SquadrantConfig;
  const put = (dir: string, body: string) => {
    fs.mkdirSync(path.join(dir, "daily-logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "daily-logs", "2026-10-15.md"), body);
  };
  const ws = () => path.join(process.env.SQUADRANT_WORKSPACE_DIR!, "p", "artifacts");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-daily-log-"));
    config = { projects: { p: { path: tmp, captainName: "c", spokeVault: path.join(tmp, "spoke"), host: "local" } } } as unknown as SquadrantConfig;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(ws()), { recursive: true, force: true });
  });

  it("reads workspace/<p>/artifacts/daily-logs/ first", async () => {
    put(ws(), "## Blocked\n- new\n");
    put(path.join(tmp, "spoke"), "## Blocked\n- old\n");
    expect((await readProjectDailyLog("p", config, "2026-10-15"))?.blockers).toEqual(["new"]);
  });

  it("falls back to the spoke's daily-logs/", async () => {
    put(path.join(tmp, "spoke"), "## Blocked\n- old\n");
    expect((await readProjectDailyLog("p", config, "2026-10-15"))?.blockers).toEqual(["old"]);
  });

  it("returns null when neither has the day", async () => {
    expect(await readProjectDailyLog("p", config, "2026-10-15")).toBeNull();
  });
});
