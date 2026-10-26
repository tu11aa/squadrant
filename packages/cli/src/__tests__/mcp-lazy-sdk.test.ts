import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SDK = "@modelcontextprotocol/sdk";

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : sources(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("MCP SDK is lazily imported (#1029)", () => {
  it("no static import of the SDK anywhere in packages/*/src", () => {
    const offenders = sources(path.join(root, "packages")).filter((f) => {
      if (f.includes(`${path.sep}node_modules${path.sep}`)) return false;
      return new RegExp(`^\\s*(import|export)\\b[^;]*from\\s+["']${SDK}`, "m").test(fs.readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("built dist/index.js (when present) only reaches the SDK through dynamic import()", () => {
    const dist = path.join(root, "dist", "index.js");
    if (!fs.existsSync(dist)) return;
    const js = fs.readFileSync(dist, "utf8");
    expect(js).toContain(`import("${SDK}`);
    expect(js).not.toMatch(new RegExp(`from\\s*["']${SDK}`));
  });
});
