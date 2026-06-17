import type { WorkspaceDriver } from "../types/workspaces.js";

export const SPOKE_SUBDIRS = [
  "crew",
  "learnings",
  "daily-logs",
  "skills",
  "meta",
  "templates",
  "wiki",
  "wiki/pages",
];

export async function ensureSpokeLayout(workspace: WorkspaceDriver): Promise<void> {
  for (const sub of SPOKE_SUBDIRS) {
    await workspace.mkdir(sub);
  }
}
