// Guard (#979 §4.6): no test writes the operator's real audit log. 181 `kb: "t"` lines leaked into
// ~/.local/state/squadrant/audit from tests that called applyCandidates with no audit sink, until test/setup-env.ts
// (b0ca7ba) pointed SQUADRANT_AUDIT_DIR at a per-worker tmp dir. This file fails if that seam is ever lost.
// It never reads or writes the real dir: it only compares paths.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAudit, auditMachineId, defaultAuditDir } from "../knowledge/index.js";

const REAL = path.join(os.homedir(), ".local", "state", "squadrant", "audit");
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return !r.startsWith("..") && !path.isAbsolute(r); };
const monthFile = () => path.join(defaultAuditDir(), `${new Date().toISOString().slice(0, 7)}.${auditMachineId()}.jsonl`);
const lines = () => (fs.existsSync(monthFile()) ? fs.readFileSync(monthFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("audit log is hermetic in tests", () => {
  it("defaultAuditDir() is the setup's tmp dir, never under the real state dir", () => {
    expect(process.env.SQUADRANT_AUDIT_DIR).toBeTruthy();
    expect(defaultAuditDir()).toBe(process.env.SQUADRANT_AUDIT_DIR);
    expect(inside(defaultAuditDir(), os.tmpdir())).toBe(true);
    expect(inside(path.resolve(defaultAuditDir()), REAL)).toBe(false);
  });
  it("an audit write with no explicit sink (applyCandidates' leak path) lands in the hermetic dir", () => {
    appendAudit([{ kb: "guard", level: "shared", project: "", domain: "rules", itemId: "guard.no-sink", event: "item.surfaced" }]);
    expect(lines().some((l) => l.itemId === "guard.no-sink")).toBe(true);
  });
});
