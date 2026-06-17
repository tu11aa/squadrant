import { describe, it, expect } from "vitest";
import { ProjectionRegistry } from "../registry.js";
import type { ProjectionEmitter } from "@cockpit/shared";

function stub(name: string): () => ProjectionEmitter {
  return () => ({
    name,
    destinations: () => [],
    emit: async () => ({ written: false, path: "", bytesWritten: 0 }),
  });
}

describe("ProjectionRegistry", () => {
  it("get returns the registered emitter by name", () => {
    const reg = new ProjectionRegistry({
      cursor: stub("cursor"),
      codex: stub("codex"),
    });
    expect(reg.get("cursor").name).toBe("cursor");
    expect(reg.get("codex").name).toBe("codex");
  });

  it("get throws on unknown name with helpful message", () => {
    const reg = new ProjectionRegistry({ cursor: stub("cursor") });
    expect(() => reg.get("slack")).toThrowError(/unknown projection target 'slack'/i);
  });

  it("list returns registered target names", () => {
    const reg = new ProjectionRegistry({
      cursor: stub("cursor"),
      codex: stub("codex"),
      gemini: stub("gemini"),
    });
    expect(reg.list().sort()).toEqual(["codex", "cursor", "gemini"]);
  });
});
