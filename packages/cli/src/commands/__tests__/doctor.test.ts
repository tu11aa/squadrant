import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { check, candidateGlobalInstalls, findInstalledSquadrants, formatDuplicateInstallWarning } from "../doctor.js";

describe("doctor check() hint rendering", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints only the PASS line when pass=true (no hint)", () => {
    const result = check("Claude Code installed", true);
    expect(result).toBe(true);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/PASS/);
    expect(output[0]).toMatch(/Claude Code installed/);
  });

  it("prints only the FAIL line when pass=false and no hint", () => {
    const result = check("Node.js >= 18", false);
    expect(result).toBe(false);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/FAIL/);
  });

  it("prints FAIL line + hint line when pass=false with hint", () => {
    const result = check("Squadrant config exists", false, "Run: squadrant init");
    expect(result).toBe(false);
    expect(output).toHaveLength(2);
    expect(output[0]).toMatch(/FAIL/);
    expect(output[0]).toMatch(/Squadrant config exists/);
    expect(output[1]).toMatch(/squadrant init/);
  });

  it("does NOT print hint when pass=true even if hint is provided", () => {
    check("Agent Teams enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)", true,
      "Run: squadrant init  (enables automatically)");
    expect(output).toHaveLength(1);
    expect(output[0]).not.toMatch(/squadrant init/);
  });

  it("hint line contains the → indicator", () => {
    check("Plugin: superpowers", false, "In Claude Code, run: /plugin marketplace add superpowers");
    expect(output[1]).toMatch(/→/);
    expect(output[1]).toMatch(/\/plugin marketplace add superpowers/);
  });

  it("hint line contains the → indicator for claude-mem", () => {
    check("Plugin: claude-mem", false, "In Claude Code, run: /plugin marketplace add thedotmack/claude-mem");
    expect(output[1]).toMatch(/thedotmack\/claude-mem/);
  });

  it("hint line contains the → indicator for context7", () => {
    check("Plugin: context7", false, "In Claude Code, run: /plugin marketplace add context7");
    expect(output[1]).toMatch(/context7/);
  });

  it("workspace hint points to squadrant init", () => {
    check("Workspace 'obsidian' — hub reachable", false, "Run: squadrant init  to scaffold the hub vault");
    expect(output[1]).toMatch(/squadrant init/);
  });
});

// #670-C: doctor must surface duplicate global installs (npm + pnpm + yarn all
// claim their own daemon entry, and one flip-flops the other's plist).
describe("candidateGlobalInstalls", () => {
  it("builds a squadrant/package.json candidate per known root", () => {
    const candidates = candidateGlobalInstalls({
      npm: "/Users/me/.nvm/versions/node/v24/lib/node_modules",
      pnpm: "/Users/me/Library/pnpm/global/5/node_modules",
      yarn: "/Users/me/.config/yarn/global",
    });
    expect(candidates).toEqual([
      { manager: "npm", packageJsonPath: "/Users/me/.nvm/versions/node/v24/lib/node_modules/squadrant/package.json" },
      { manager: "pnpm", packageJsonPath: "/Users/me/Library/pnpm/global/5/node_modules/squadrant/package.json" },
      { manager: "yarn", packageJsonPath: "/Users/me/.config/yarn/global/node_modules/squadrant/package.json" },
    ]);
  });

  it("skips roots that couldn't be resolved", () => {
    const candidates = candidateGlobalInstalls({ npm: "/only/npm/root" });
    expect(candidates).toEqual([
      { manager: "npm", packageJsonPath: "/only/npm/root/squadrant/package.json" },
    ]);
  });

  it("returns an empty list when no roots resolved", () => {
    expect(candidateGlobalInstalls({})).toEqual([]);
  });
});

describe("findInstalledSquadrants", () => {
  it("keeps only candidates whose package.json actually resolves a version", () => {
    const candidates = [
      { manager: "npm" as const, packageJsonPath: "/npm/squadrant/package.json" },
      { manager: "pnpm" as const, packageJsonPath: "/pnpm/squadrant/package.json" },
    ];
    const readVersion = vi.fn((p: string) => (p.includes("pnpm") ? "0.18.0" : null));
    expect(findInstalledSquadrants(candidates, readVersion)).toEqual([
      { manager: "pnpm", packageJsonPath: "/pnpm/squadrant/package.json", version: "0.18.0" },
    ]);
  });
});

describe("formatDuplicateInstallWarning", () => {
  it("returns null when zero or one install is found (nothing to warn about)", () => {
    expect(formatDuplicateInstallWarning([])).toBeNull();
    expect(formatDuplicateInstallWarning([{ manager: "pnpm", packageJsonPath: "/pnpm/squadrant/package.json", version: "0.18.0" }])).toBeNull();
  });

  it("names both paths and versions when more than one install is found", () => {
    const msg = formatDuplicateInstallWarning([
      { manager: "pnpm", packageJsonPath: "/Users/me/Library/pnpm/global/5/node_modules/squadrant/package.json", version: "0.18.0" },
      { manager: "npm", packageJsonPath: "/Users/me/.nvm/versions/node/v24/lib/node_modules/squadrant/package.json", version: "0.16.3" },
    ]);
    expect(msg).toContain("/Users/me/Library/pnpm/global/5/node_modules/squadrant/package.json");
    expect(msg).toContain("0.18.0");
    expect(msg).toContain("/Users/me/.nvm/versions/node/v24/lib/node_modules/squadrant/package.json");
    expect(msg).toContain("0.16.3");
  });
});
