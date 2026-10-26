import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInitPrompt, readInitPrompt, INIT_PROMPT_INLINE_MAX_BYTES } from "../first-turn-init.js";

const stateRoot = () => mkdtempSync(join(tmpdir(), "init-prompt-"));

describe("writeInitPrompt / readInitPrompt", () => {
  it("stores brief.md verbatim (0600) and init.md under <stateRoot>/<project>/<taskId>", () => {
    const root = stateRoot();
    const brief = "a ===\n(b): $HOME `x`";
    const r = writeInitPrompt({ stateRoot: root, project: "p", taskId: "t1", brief, fromFile: false, completionProtocol: "PROTO" });
    expect(r.briefPath).toBe(join(root, "p", "t1", "brief", "brief.md"));
    expect(r.initPath).toBe(join(root, "p", "t1", "init.md"));
    expect(readFileSync(r.briefPath, "utf8")).toBe(brief);
    expect(statSync(r.briefPath).mode & 0o777).toBe(0o600);
    expect(readInitPrompt(root, "p", "t1")).toBe(r.initText);
    expect(r.initText).toBe(`📨 captain:p → task · taskId: t1\n${brief}\n\nPROTO`);
  });

  it("inlines up to the threshold, points at brief.md above it", () => {
    const root = stateRoot();
    const at = writeInitPrompt({ stateRoot: root, project: "p", taskId: "a", brief: "x".repeat(INIT_PROMPT_INLINE_MAX_BYTES), fromFile: false, completionProtocol: "P" });
    expect(at.initText).not.toContain("to get your task brief");
    const over = writeInitPrompt({ stateRoot: root, project: "p", taskId: "b", brief: "x".repeat(INIT_PROMPT_INLINE_MAX_BYTES + 1), fromFile: false, completionProtocol: "P" });
    expect(over.initText).toContain(`Read ${over.briefPath} to get your task brief, then execute it.`);
  });

  it("readInitPrompt is undefined for a task without one (resend falls back to the brief)", () => {
    expect(readInitPrompt(stateRoot(), "p", "none")).toBeUndefined();
  });
});
