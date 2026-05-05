import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ORCH_DIR = path.join(REPO_ROOT, "orchestrator");

const FORBIDDEN: ReadonlyArray<string> = [
  "TaskCreate",
  "TaskUpdate",
  "TeamCreate",
];

const FORBIDDEN_AS_TOOL_TOKEN: ReadonlyArray<string> = [
  "Agent",
  "Skill",
];

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(ORCH_DIR, name), "utf-8");
}

function findForbidden(body: string): string[] {
  const hits: string[] = [];
  for (const tok of FORBIDDEN) {
    const re = new RegExp(`\\b${tok}\\b`);
    if (re.test(body)) hits.push(tok);
  }
  for (const tok of FORBIDDEN_AS_TOOL_TOKEN) {
    const re = new RegExp("`" + tok + "`");
    if (re.test(body)) hits.push("`" + tok + "`");
  }
  return hits;
}

describe("generic role templates — audit", () => {
  it("captain.generic.md exists and is non-empty", () => {
    const body = readTemplate("captain.generic.md");
    expect(body.length).toBeGreaterThan(100);
  });

  it("crew.generic.md exists and is non-empty", () => {
    const body = readTemplate("crew.generic.md");
    expect(body.length).toBeGreaterThan(50);
  });

  it("captain.generic.md contains zero Claude-specific tool references", () => {
    const body = readTemplate("captain.generic.md");
    expect(findForbidden(body)).toEqual([]);
  });

  it("crew.generic.md contains zero Claude-specific tool references", () => {
    const body = readTemplate("crew.generic.md");
    expect(findForbidden(body)).toEqual([]);
  });

  it("guard test catches a forbidden token if reintroduced (smoke)", () => {
    const fake = "If your task fails, call `TaskCreate` to escalate.";
    expect(findForbidden(fake)).toContain("TaskCreate");
  });

  it("captain.generic.md uses the cockpit crew spawn primitive", () => {
    const body = readTemplate("captain.generic.md");
    expect(body).toMatch(/cockpit crew spawn/);
  });
});
