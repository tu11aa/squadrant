import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRulesPointer, auditFallback } from "../projection.js";
import { mergeWithMarkers } from "@squadrant/agents";

describe("rules fallback pointer (#900)", () => {
  const src = { instructions: "# Project\nhand-written", skills: [] };
  it("subscribing project: pointer is appended to the marker body for codex/gemini/opencode only", () => {
    for (const t of ["codex", "gemini", "opencode"]) {
      const out = withRulesPointer(src, t, ["saitex"]);
      expect(out.instructions).toContain("squadrant rules search");
      expect(out.instructions).toContain("saitex");
    }
    expect(withRulesPointer(src, "cursor", ["saitex"])).toBe(src);
    expect(withRulesPointer(src, "claude", ["saitex"])).toBe(src);
  });
  it("non-subscribing project: source unchanged", () => {
    expect(withRulesPointer(src, "codex", [])).toBe(src);
  });
  it("lands only inside the markers, and a re-emit after unsubscribing removes it", () => {
    const user = "# Mine\n";
    const on = mergeWithMarkers(user, withRulesPointer(src, "codex", ["saitex"]).instructions);
    const [before] = on.split("<!-- squadrant:start -->");
    expect(before.trim()).toBe(user.trim());
    expect(on).toContain("squadrant rules search");
    const off = mergeWithMarkers(on, withRulesPointer(src, "codex", []).instructions);
    expect(off).not.toContain("squadrant rules search");
    expect(off.startsWith(user)).toBe(true);
  });

  it("auditFallback logs one trigger=fallback entry per KB for the agent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-fb-"));
    const prev = process.env.SQUADRANT_AUDIT_DIR;
    process.env.SQUADRANT_AUDIT_DIR = dir;
    try {
      auditFallback("flooros", ["saitex"], "gemini");
      const lines = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)).map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kb: "saitex", project: "flooros", event: "item.fallback", trigger: "fallback", agent: "gemini" });
    } finally {
      if (prev === undefined) delete process.env.SQUADRANT_AUDIT_DIR; else process.env.SQUADRANT_AUDIT_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
