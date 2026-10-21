"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Hermetic operator dirs: no test may touch the operator's real
// ~/.local/state/squadrant/audit (it feeds live KB rule-usefulness stats),
// ~/squadrant/workspace or ~/squadrant/archive (#983 6b).
// Tests that need a specific dir still override these env vars themselves.
var node_fs_1 = require("node:fs");
var node_os_1 = require("node:os");
var node_path_1 = require("node:path");
var dirs = {
    SQUADRANT_AUDIT_DIR: "squadrant-test-audit-",
    SQUADRANT_WORKSPACE_DIR: "squadrant-test-workspace-",
    SQUADRANT_ARCHIVE_DIR: "squadrant-test-archive-",
    // #983 6a: the daemon state root (~/.local/state/squadrant): mailboxes, task
    // store, results and sessions.json must never land in the live state.
    SQUADRANT_STATE_DIR: "squadrant-test-state-",
    // #982: the operator profile KB and the Claude native-memory root the bridge reads.
    SQUADRANT_USER_KB_DIR: "squadrant-test-user-kb-",
    SQUADRANT_NATIVE_MEMORY_ROOT: "squadrant-test-native-memory-",
};
var made = [];
for (var _i = 0, _a = Object.entries(dirs); _i < _a.length; _i++) {
    var _b = _a[_i], env = _b[0], prefix = _b[1];
    var dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), prefix));
    process.env[env] = dir;
    made.push(dir);
}
process.on("exit", function () { for (var _i = 0, made_1 = made; _i < made_1.length; _i++) {
    var d = made_1[_i];
    try {
        node_fs_1.default.rmSync(d, { recursive: true, force: true });
    }
    catch ( /* best effort */_a) { /* best effort */ }
} });
