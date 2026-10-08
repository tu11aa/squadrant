import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// Template paths read by `init` (hub) and `projects add` (spoke), relative to the package root.
const REQUIRED = [
  "obsidian/hub/dashboard.md",
  "obsidian/hub/templates/project-summary.md",
  "obsidian/spoke/status.md",
];

describe("npm package contents", () => {
  it("ships the hub/spoke templates read by init and projects add", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const packed = new Set(
      (JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path),
    );
    for (const p of REQUIRED) expect(packed, p).toContain(p);
  }, 60_000);
});
