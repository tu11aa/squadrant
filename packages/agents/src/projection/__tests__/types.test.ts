import { describe, it, expect } from "vitest";
import type { CockpitConfig } from "@cockpit/shared";
import type {
  ProjectionSource,
  ProjectionDestination,
  ProjectionEmitter,
  ProjectionEmitResult,
  ProjectionEmitterFactory,
} from "@cockpit/shared";

describe("projection types", () => {
  it("CockpitConfig accepts optional projection.targets", () => {
    const cfg: CockpitConfig = {
      commandName: "cmd",
      hubVault: "~/hub",
      projects: {},
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "default", captain: "acceptEdits" },
      },
      metrics: { enabled: false, path: "" },
      projection: { targets: ["cursor", "codex"] },
    };
    expect(cfg.projection?.targets).toEqual(["cursor", "codex"]);
  });

  it("ProjectionSource requires instructions and skills", () => {
    const src: ProjectionSource = {
      instructions: "# Rules",
      skills: [{ name: "x", description: "d", content: "c" }],
    };
    expect(src.skills).toHaveLength(1);
  });

  it("ProjectionDestination distinguishes shared vs dedicated", () => {
    const dest: ProjectionDestination = {
      path: "/tmp/x.md",
      shared: true,
      format: "markdown",
    };
    expect(dest.shared).toBe(true);
  });

  it("ProjectionEmitter has name + destinations + emit", () => {
    const emitter: ProjectionEmitter = {
      name: "stub",
      destinations: () => [],
      emit: async () => ({ written: false, path: "", bytesWritten: 0 }),
    };
    expect(emitter.name).toBe("stub");
  });

  it("ProjectionEmitterFactory produces an emitter with zero args", () => {
    const factory: ProjectionEmitterFactory = () => ({
      name: "stub",
      destinations: () => [],
      emit: async () => ({ written: false, path: "", bytesWritten: 0 }),
    });
    expect(factory().name).toBe("stub");
  });
});
