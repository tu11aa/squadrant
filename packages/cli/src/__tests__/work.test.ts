// packages/cli/src/__tests__/work.test.ts
import { describe, it, expect } from "vitest";
import { detectCurrentProject, groupByParent, visibleItems } from "../commands/work.js";
import type { SquadrantConfig, WorkItem } from "@squadrant/shared";

function item(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: "w_0000", project: "proj", title: "t", state: "working", parent: null,
    tags: [], note: "", crewTaskIds: [], issue: null,
    createdAt: 0, updatedAt: 0, closedAt: null,
    ...overrides,
  };
}

describe("detectCurrentProject", () => {
  const config = {
    projects: {
      friendslop: { path: "/repo/friendslop-factory" },
      oneplan: { path: "/repo/oneplan" },
    },
  } as unknown as SquadrantConfig;

  it("matches when cwd is exactly the project path", () => {
    expect(detectCurrentProject(config, "/repo/friendslop-factory")).toBe("friendslop");
  });

  it("matches when cwd is a subdirectory of the project path", () => {
    expect(detectCurrentProject(config, "/repo/oneplan/packages/api")).toBe("oneplan");
  });

  it("does not match a sibling path with a shared string prefix", () => {
    // /repo/oneplan-extra is NOT under /repo/oneplan
    expect(detectCurrentProject(config, "/repo/oneplan-extra")).toBeUndefined();
  });

  it("returns undefined outside any registered project", () => {
    expect(detectCurrentProject(config, "/tmp/somewhere")).toBeUndefined();
  });
});

describe("groupByParent — out-of-order wave completion is the point of the design", () => {
  it("nests children under their wave and leaves a parentless incident flat at top level", () => {
    const wave3 = item({ id: "wave-3", title: "Wave 3" });
    const child = item({ id: "child-1", title: "matchmaking", parent: "wave-3" });
    const incident = item({ id: "incident-1", title: "prod fire", parent: null });

    const { roots, childrenOf } = groupByParent([wave3, child, incident]);

    expect(roots.map((r) => r.id).sort()).toEqual(["incident-1", "wave-3"]);
    expect(childrenOf.get("wave-3")?.map((c) => c.id)).toEqual(["child-1"]);
  });

  it("treats a dangling parent reference (parent item not in the set) as top-level, not lost", () => {
    const orphan = item({ id: "orphan", parent: "does-not-exist" });
    const { roots, childrenOf } = groupByParent([orphan]);
    expect(roots.map((r) => r.id)).toEqual(["orphan"]);
    expect(childrenOf.size).toBe(0);
  });

  it("waves finishing out of order does not affect grouping — order is never encoded", () => {
    const wave1 = item({ id: "w1" });
    const wave2 = item({ id: "w2", state: "done" });
    const childOf1 = item({ id: "c1", parent: "w1" });
    const { roots } = groupByParent([wave2, wave1, childOf1]);
    expect(roots.map((r) => r.id).sort()).toEqual(["w1", "w2"]);
  });
});

describe("visibleItems — a done parent must not orphan an unfinished child", () => {
  it("keeps a done parent visible when a direct child is still open", () => {
    const wave = item({ id: "wave", state: "done" });
    const child = item({ id: "child", parent: "wave", state: "working" });
    const kept = visibleItems([wave, child], false);
    expect(kept.map((i) => i.id).sort()).toEqual(["child", "wave"]);
  });

  it("hides a done parent whose children are all terminal too", () => {
    const wave = item({ id: "wave", state: "done" });
    const child = item({ id: "child", parent: "wave", state: "cancelled" });
    const kept = visibleItems([wave, child], false);
    expect(kept).toEqual([]);
  });

  it("hides a standalone done item with no children, same as before the fix", () => {
    const done = item({ id: "done-1", state: "done" });
    expect(visibleItems([done], false)).toEqual([]);
  });

  it("keeps every ancestor in a multi-level chain when the leaf is still open", () => {
    const grandparent = item({ id: "gp", state: "done" });
    const parent = item({ id: "p", parent: "gp", state: "done" });
    const leaf = item({ id: "leaf", parent: "p", state: "blocked" });
    const kept = visibleItems([grandparent, parent, leaf], false);
    expect(kept.map((i) => i.id).sort()).toEqual(["gp", "leaf", "p"]);
  });

  it("a parentless incident (not a wave) is unaffected — normal non-terminal visibility", () => {
    const incident = item({ id: "incident", parent: null, state: "working" });
    expect(visibleItems([incident], false)).toEqual([incident]);
  });

  it("--include-done bypasses pruning entirely, including all-terminal subtrees", () => {
    const wave = item({ id: "wave", state: "done" });
    const child = item({ id: "child", parent: "wave", state: "cancelled" });
    const kept = visibleItems([wave, child], true);
    expect(kept.map((i) => i.id).sort()).toEqual(["child", "wave"]);
  });
});
