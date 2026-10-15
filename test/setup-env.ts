// Hermetic operator dirs: no test may touch the operator's real
// ~/.local/state/squadrant/audit (it feeds live KB rule-usefulness stats),
// ~/squadrant/workspace or ~/squadrant/archive (#983 6b).
// Tests that need a specific dir still override these env vars themselves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = {
  SQUADRANT_AUDIT_DIR: "squadrant-test-audit-",
  SQUADRANT_WORKSPACE_DIR: "squadrant-test-workspace-",
  SQUADRANT_ARCHIVE_DIR: "squadrant-test-archive-",
};
const made: string[] = [];
for (const [env, prefix] of Object.entries(dirs)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env[env] = dir;
  made.push(dir);
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
