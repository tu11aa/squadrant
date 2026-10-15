// src/workspace.ts — #983 6b (KB spec K7, §4): per-project exchange dir that replaces hub/spokes/<p>/.
import os from "node:os";
import path from "node:path";

/** handoffs + side-handoffs are exchange; artifacts holds dated, immutable reports/research/findings/recaps/plans/daily-logs. */
export const WORKSPACE_SUBDIRS = ["handoffs", "side-handoffs", "inbox", "artifacts"] as const;

/** `SQUADRANT_WORKSPACE_DIR` overrides the root (tests, relocated homes). */
export const workspaceRoot = () => process.env.SQUADRANT_WORKSPACE_DIR || path.join(os.homedir(), "squadrant", "workspace");

export const workspacePath = (project: string) => path.join(workspaceRoot(), project);

/** Where `squadrant migrate kb` archives retired hub files. `SQUADRANT_ARCHIVE_DIR` overrides it. */
export const archiveRoot = () => process.env.SQUADRANT_ARCHIVE_DIR || path.join(os.homedir(), "squadrant", "archive");
