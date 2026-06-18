import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCursorEmitter } from "../cursor.js";
import type { ProjectionSource } from "@cockpit/shared";

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsMock);

const source: ProjectionSource = {
  instructions: "# Project rules\nuse design tokens",
  skills: [
    { name: "karpathy-principles", description: "K", content: "1. Think\n2. Simplify" },
  ],
};

describe("CursorEmitter", () => {
  beforeEach(() => {
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
    fsMock.readFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'cursor'", () => {
    expect(createCursorEmitter().name).toBe("cursor");
  });

  it("destinations(user) targets ~/.cursor/rules/cockpit-global.mdc as dedicated", () => {
    const dests = createCursorEmitter().destinations("user");
    expect(dests).toHaveLength(1);
    expect(dests[0].path).toMatch(/\.cursor\/rules\/cockpit-global\.mdc$/);
    expect(dests[0].shared).toBe(false);
    expect(dests[0].format).toBe("mdc");
  });

  it("destinations(project, root) targets {root}/.cursor/rules/cockpit.mdc as dedicated", () => {
    const dests = createCursorEmitter().destinations("project", "/brove");
    expect(dests).toHaveLength(1);
    expect(dests[0].path).toBe("/brove/.cursor/rules/cockpit.mdc");
    expect(dests[0].shared).toBe(false);
  });

  it("emit writes .mdc with frontmatter and inlined skill content", async () => {
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    const result = await emitter.emit(source, dest);

    expect(result.written).toBe(true);
    expect(fsMock.mkdir).toHaveBeenCalledWith("/brove/.cursor/rules", { recursive: true });
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain("description:");
    expect(written).toContain("globs:");
    expect(written).toContain("alwaysApply: true");
    expect(written).toContain("Project rules");
    expect(written).toContain("karpathy-principles");
    expect(written).toContain("1. Think");
  });

  it("emit overwrites existing dedicated file without marker-merge", async () => {
    fsMock.readFile.mockResolvedValueOnce("STALE CONTENT");
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).not.toContain("STALE CONTENT");
    expect(written).not.toContain("cockpit:start");
  });

  it("emit with dryRun returns diff and does not write", async () => {
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    const result = await emitter.emit(source, dest, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.diff).toBeDefined();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("emit returns bytesWritten on write", async () => {
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("user");
    const result = await emitter.emit(source, dest);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  it("emit writes role-template sections inside the .mdc body (#45)", async () => {
    const roleSource: ProjectionSource = {
      instructions: "## Captain Role\n\nC body\n\n## Crew Role\n\nW body",
      skills: [],
    };
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(roleSource, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toMatch(/^---\n[\s\S]*?\n---\n/);
    expect(written).toContain("## Captain Role");
    expect(written).toContain("## Crew Role");
    expect(written.indexOf("## Captain Role")).toBeLessThan(written.indexOf("## Crew Role"));
  });
});
