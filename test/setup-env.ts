// Hermetic audit log: no test may append to the operator's real
// ~/.local/state/squadrant/audit (it feeds live KB rule-usefulness stats).
// Tests that need a specific dir still override SQUADRANT_AUDIT_DIR themselves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-test-audit-"));
process.env.SQUADRANT_AUDIT_DIR = dir;
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
