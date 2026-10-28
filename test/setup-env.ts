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
  // #983 6a: the daemon state root (~/.local/state/squadrant): mailboxes, task
  // store, results and sessions.json must never land in the live state.
  SQUADRANT_STATE_DIR: "squadrant-test-state-",
  // #982: the operator profile KB and the Claude native-memory root the bridge reads.
  SQUADRANT_USER_KB_DIR: "squadrant-test-user-kb-",
  SQUADRANT_NATIVE_MEMORY_ROOT: "squadrant-test-native-memory-",
  // #979 phase 2: the default KB parent dir (~/squadrant/kb) and the per-machine verdicts dir.
  SQUADRANT_KB_ROOT: "squadrant-test-kb-root-",
  SQUADRANT_VERDICTS_DIR: "squadrant-test-verdicts-",
};
const made: string[] = [];
for (const [env, prefix] of Object.entries(dirs)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env[env] = dir;
  made.push(dir);
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
