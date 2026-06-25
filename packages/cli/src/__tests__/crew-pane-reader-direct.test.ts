import { describe, it, expect } from "vitest";
import { createDirectSurfaceLivenessProbe, crewPaneTitle } from "@squadrant/core";
import type { DaemonCmux } from "@squadrant/workspaces";
import type { TaskRecord } from "@squadrant/shared";

function mockCmux(overrides?: Partial<DaemonCmux>): DaemonCmux {
  return {
    send: async () => {},
    listSurfaces: async () => [],
    readScreen: async () => null,
    isAvailable: async () => true,
    findWorkspaceId: async () => null,
    ...overrides,
  } as unknown as DaemonCmux;
}

const TASK: TaskRecord = {
  id: "t1", project: "p", provider: "claude", mode: "interactive",
  state: "working", task: "test", createdAt: 1, lastHeartbeat: 1,
  lastEvent: "", heartbeatBudgetMs: 1000,
  name: "crew-1",
  attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
};

describe("createDirectSurfaceLivenessProbe (#332)", () => {
  it("returns alive when captain workspace surfaces contain the crew pane", async () => {
    const wantTitle = crewPaneTitle("p", "crew-1");
    const cmux = mockCmux({
      findWorkspaceId: async () => "ws:1",
      listSurfaces: async () => [
        { workspaceId: "ws:1", surfaceId: "s1", title: "⚓ p-captain" },
        { workspaceId: "ws:1", surfaceId: "s2", title: wantTitle },
      ],
    });
    const probe = createDirectSurfaceLivenessProbe(cmux, () => "p-captain");
    await expect(probe(TASK)).resolves.toBe("alive");
  });

  it("returns gone when surfaces are non-empty but lack the crew pane", async () => {
    const cmux = mockCmux({
      findWorkspaceId: async () => "ws:1",
      listSurfaces: async () => [
        { workspaceId: "ws:1", surfaceId: "s1", title: "⚓ p-captain" },
        { workspaceId: "ws:1", surfaceId: "s2", title: "🔧 p:other-crew" },
      ],
    });
    const probe = createDirectSurfaceLivenessProbe(cmux, () => "p-captain");
    await expect(probe(TASK)).resolves.toBe("gone");
  });

  it("returns unknown when listSurfaces returns empty (fail-soft)", async () => {
    const cmux = mockCmux({
      findWorkspaceId: async () => "ws:1",
      listSurfaces: async () => [],
    });
    const probe = createDirectSurfaceLivenessProbe(cmux, () => "p-captain");
    await expect(probe(TASK)).resolves.toBe("unknown");
  });

  it("returns unknown when findWorkspaceId returns null (cmux unreachable)", async () => {
    const cmux = mockCmux({
      findWorkspaceId: async () => null,
    });
    const probe = createDirectSurfaceLivenessProbe(cmux, () => "p-captain");
    await expect(probe(TASK)).resolves.toBe("unknown");
  });

  it("returns unknown for non-interactive task", async () => {
    const probe = createDirectSurfaceLivenessProbe(mockCmux(), () => "p-captain");
    await expect(probe({ ...TASK, mode: "headless" })).resolves.toBe("unknown");
  });

  it("returns unknown for unnamed task", async () => {
    const probe = createDirectSurfaceLivenessProbe(mockCmux(), () => "p-captain");
    await expect(probe({ ...TASK, name: undefined })).resolves.toBe("unknown");
  });

  it("returns unknown on exception from any cmux method", async () => {
    const cmux = mockCmux({
      findWorkspaceId: async () => { throw new Error("cmux boom"); },
    });
    const probe = createDirectSurfaceLivenessProbe(cmux, () => "p-captain");
    await expect(probe(TASK)).resolves.toBe("unknown");
  });
});
