import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClaudeEmitter } from "../claude.js";
import type { ProjectionSource } from "@squadrant/shared";
import { MARKER_START, MARKER_END } from "../marker.js";

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsMock);

const source: ProjectionSource = {
  instructions: "# Project rules",
  skills: [{ name: "karpathy-principles", description: "K", content: "body" }],
};

describe("ClaudeEmitter", () => {
  beforeEach(() => {
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
    fsMock.readFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'claude'", () => {
    expect(createClaudeEmitter().name).toBe("claude");
  });

  it("destinations(user) targets ~/.claude/CLAUDE.md as shared", () => {
    const [dest] = createClaudeEmitter().destinations("user");
    expect(dest.path).toMatch(/\.claude\/CLAUDE\.md$/);
    expect(dest.shared).toBe(true);
    expect(dest.format).toBe("markdown");
  });

  it("destinations(project, root) targets {root}/CLAUDE.md as shared", () => {
    const [dest] = createClaudeEmitter().destinations("project", "/brove");
    expect(dest.path).toBe("/brove/CLAUDE.md");
    expect(dest.shared).toBe(true);
  });

  it("emit wraps content in squadrant markers when file is new", async () => {
    const emitter = createClaudeEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain(MARKER_START);
    expect(written).toContain(MARKER_END);
    expect(written).toContain("Project rules");
    expect(written).toContain("karpathy-principles");
  });

  it("emit preserves surrounding content when file exists", async () => {
    fsMock.readFile.mockResolvedValueOnce("# My personal notes\n\nhello\n");
    const emitter = createClaudeEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("My personal notes");
    expect(written).toContain(MARKER_START);
  });

  it("emit updates marker block without duplicating it (non-clobbering re-emit)", async () => {
    fsMock.readFile.mockResolvedValueOnce(
      `preamble\n${MARKER_START}\nOLD\n${MARKER_END}\nepilog\n`,
    );
    const emitter = createClaudeEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("preamble");
    expect(written).toContain("epilog");
    expect(written).not.toContain("OLD");
    const starts = (written.match(new RegExp(MARKER_START, "g")) ?? []).length;
    expect(starts).toBe(1);
  });

  it("emit with dryRun returns diff and does not write", async () => {
    const emitter = createClaudeEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    const result = await emitter.emit(source, dest, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.diff).toBeDefined();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("emit writes role-template sections inside the squadrant marker block (#45)", async () => {
    const roleSource: ProjectionSource = {
      instructions: "## Captain Role\n\nC body\n\n## Crew Role\n\nW body",
      skills: [],
    };
    const emitter = createClaudeEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(roleSource, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain(MARKER_START);
    expect(written).toContain("## Captain Role");
    expect(written).toContain("## Crew Role");
    expect(written.indexOf("## Captain Role")).toBeLessThan(written.indexOf("## Crew Role"));
    expect(written).toContain(MARKER_END);
  });
});
