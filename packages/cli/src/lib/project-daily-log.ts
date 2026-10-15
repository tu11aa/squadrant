// project-daily-log.ts — #983: daily logs are dated, immutable artifacts in
// workspace/<p>/artifacts/daily-logs/; the old spoke daily-logs/ is still read for one version.
import path from "node:path";
import { readDailyLog, workspacePath, type DailyLog, type SquadrantConfig } from "@squadrant/shared";
import { createObsidianDriver, WorkspaceRegistry } from "@squadrant/workspaces";

export async function readProjectDailyLog(project: string, config: SquadrantConfig, dateStr: string): Promise<DailyLog | null> {
  const fresh = await readDailyLog(createObsidianDriver({ root: path.join(workspacePath(project), "artifacts") }), dateStr);
  return fresh ?? readDailyLog(new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(project, config), dateStr);
}
