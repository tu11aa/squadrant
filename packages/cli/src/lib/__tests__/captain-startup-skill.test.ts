import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #1142: the captain loads only captain-startup at startup; its trigger table must keep
// every captain-ops section and every skill captain-ops names reachable (#1109 safeguard 3).
const root = path.resolve(__dirname, "../../../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");
const startup = read("plugin/skills/captain-startup/SKILL.md");
const ops = read("plugin/skills/captain-ops/SKILL.md");

// Top-level captain-ops sections plus the subsections the table names on their own.
const SECTIONS = [
  "Message Senders", "MCP Tools", "Crew Setup", "Task Decomposition with Task Master", "Spawning Crew",
  "Leveled crew routing", "Effort mode", "Crafting Load-Bearing Crew Briefs", "Task Coordination",
  "Crew Question Triage & Discussion Threads", "Handling CREW REVIEW or CREW DONE", "When Crew is Fully Finished",
  "Live-checking a branch build", "Status Board", "Replying to Telegram-originated tasks", "Session Shutdown",
  "Project Rules (Knowledge Base)", "Group Awareness", "Cross-Project Delegation", "Recording Learnings",
  "Wiki Compilation", "Selective Loading", "Capturing Skills", "Fixing Skills", "Quality Tracking",
];

describe("captain-startup skill", () => {
  it("stays small", () => {
    expect(Buffer.byteLength(startup)).toBeLessThan(3 * 1024);
  });

  it.each(SECTIONS)("reaches captain-ops section %s", (section) => {
    expect(ops).toMatch(new RegExp("^#{2,3} " + section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m"));
    expect(startup).toContain(section);
  });

  it("names every skill that captain-ops points to", () => {
    const refs = new Set([...ops.matchAll(/squadrant:([a-z-]+)/g)].map((m) => m[1]).filter((n) => n !== "captain-startup"));
    expect(refs.size).toBeGreaterThan(0);
    for (const name of refs) expect(startup, name).toContain(name);
  });

  it("is where the init prompt and the captain templates send a captain at startup", () => {
    expect(read("packages/cli/src/commands/launch.ts")).toContain("use the squadrant:captain-startup skill");
    expect(read("scripts/spawn-workspace.sh")).toContain("use the squadrant:captain-startup skill");
    expect(read("templates/captain.claude.md")).toContain("Load `squadrant:captain-startup`");
    expect(ops).toMatch(/## Session Startup\s+Use the `squadrant:captain-startup` skill/);
  });
});
