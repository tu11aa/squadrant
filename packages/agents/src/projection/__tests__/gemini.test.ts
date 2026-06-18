import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiEmitter } from "../gemini.js";
import type { ProjectionSource } from "@cockpit/shared";
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

describe("GeminiEmitter", () => {
  beforeEach(() => {
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
    fsMock.readFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'gemini'", () => {
    expect(createGeminiEmitter().name).toBe("gemini");
  });

  it("destinations(user) targets ~/.gemini/GEMINI.md as shared", () => {
    const [dest] = createGeminiEmitter().destinations("user");
    expect(dest.path).toMatch(/\.gemini\/GEMINI\.md$/);
    expect(dest.shared).toBe(true);
  });

  it("destinations(project, root) targets {root}/GEMINI.md as shared", () => {
    const [dest] = createGeminiEmitter().destinations("project", "/brove");
    expect(dest.path).toBe("/brove/GEMINI.md");
    expect(dest.shared).toBe(true);
  });

  it("emit wraps body in cockpit markers", async () => {
    const emitter = createGeminiEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain(MARKER_START);
    expect(written).toContain(MARKER_END);
    expect(written).toContain("Project rules");
    expect(written).toContain("karpathy-principles");
  });

  it("emit preserves existing content outside markers", async () => {
    fsMock.readFile.mockResolvedValueOnce("# Gemini personal notes\n");
    const emitter = createGeminiEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("Gemini personal notes");
  });

  it("emit with dryRun returns diff and does not write", async () => {
    const emitter = createGeminiEmitter();
    const [dest] = emitter.destinations("user");
    const result = await emitter.emit(source, dest, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.diff).toBeDefined();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("emit writes role-template sections inside the cockpit marker block (#45)", async () => {
    const roleSource: ProjectionSource = {
      instructions: "## Captain Role\n\nC body\n\n## Crew Role\n\nW body",
      skills: [],
    };
    const emitter = createGeminiEmitter();
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
