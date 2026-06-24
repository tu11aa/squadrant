import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { check } from "../doctor.js";

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
