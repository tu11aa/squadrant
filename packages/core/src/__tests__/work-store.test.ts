// packages/core/src/__tests__/work-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkStore,
  createWorkItem,
  findWorkItemById,
  findOpenChildren,
  closeWorkItem,
  purgeExpiredWorkItems,
  WORK_ITEM_TTL_MS,
} from "../work-store.js";

describe("work-store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-work-store-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("createWorkItem then get round-trips through the WorkStore", () => {
    const store = createWorkStore(dir);
    const item = createWorkItem(store, { project: "proj", title: "Wave 3", now: 1000 });
    expect(item.state).toBe("working");
    expect(item.parent).toBeNull();
    expect(item.closedAt).toBeNull();
    expect(store.get("proj", item.id)).toEqual(item);
  });

  it("assigns a short w_-prefixed id", () => {
    const store = createWorkStore(dir);
    const item = createWorkItem(store, { project: "proj", title: "t", now: 1000 });
    expect(item.id).toMatch(/^w_[0-9a-f]{4}$/);
  });

  it("--parent survives round-trip and does not require same-project scoping", () => {
    const store = createWorkStore(dir);
    const wave = createWorkItem(store, { project: "proj", title: "Wave 3", now: 1000 });
    const child = createWorkItem(store, { project: "proj", title: "matchmaking", parent: wave.id, now: 1001 });
    expect(child.parent).toBe(wave.id);
  });

  it("findWorkItemById finds an item across projects with no --project given", () => {
    const store = createWorkStore(dir);
    const item = createWorkItem(store, { project: "friendslop-factory", title: "incident", now: 1000 });
    expect(findWorkItemById(store, item.id)?.project).toBe("friendslop-factory");
    expect(findWorkItemById(store, "w_nope")).toBeUndefined();
  });

  describe("findOpenChildren", () => {
    it("returns only direct children still in a non-terminal state", () => {
      const store = createWorkStore(dir);
      const wave = createWorkItem(store, { project: "proj", title: "wave", now: 0 });
      const openChild = createWorkItem(store, { project: "proj", title: "a", parent: wave.id, now: 1 });
      const closedChild = createWorkItem(store, { project: "proj", title: "b", parent: wave.id, now: 2 });
      closeWorkItem(store, closedChild.id, "done", { now: 3 });

      const open = findOpenChildren(store, wave.id);
      expect(open.map((i) => i.id)).toEqual([openChild.id]);
    });

    it("returns an empty array when a parent has no children or all are terminal", () => {
      const store = createWorkStore(dir);
      const wave = createWorkItem(store, { project: "proj", title: "wave", now: 0 });
      expect(findOpenChildren(store, wave.id)).toEqual([]);

      const child = createWorkItem(store, { project: "proj", title: "a", parent: wave.id, now: 1 });
      closeWorkItem(store, child.id, "cancelled", { now: 2 });
      expect(findOpenChildren(store, wave.id)).toEqual([]);
    });
  });

  describe("closeWorkItem", () => {
    it("transitions to done and stamps closedAt", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 1000 });
      const closed = closeWorkItem(store, item.id, "done", { note: "shipped", now: 2000 });
      expect(closed?.state).toBe("done");
      expect(closed?.closedAt).toBe(2000);
      expect(closed?.note).toBe("shipped");
      expect(store.get("proj", item.id)?.state).toBe("done");
    });

    it("transitions to cancelled", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 1000 });
      const closed = closeWorkItem(store, item.id, "cancelled", { now: 2000 });
      expect(closed?.state).toBe("cancelled");
    });

    it("returns undefined for an unknown id", () => {
      const store = createWorkStore(dir);
      expect(closeWorkItem(store, "w_nope", "done")).toBeUndefined();
    });
  });

  describe("purgeExpiredWorkItems (30-day TTL)", () => {
    it("does not purge an open (non-terminal) item no matter how old", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 0 });
      const purged = purgeExpiredWorkItems(store, WORK_ITEM_TTL_MS * 10);
      expect(purged).toBe(0);
      expect(store.get("proj", item.id)).toBeDefined();
    });

    it("keeps a done item exactly at the TTL boundary", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 0 });
      closeWorkItem(store, item.id, "done", { now: 0 });
      // now - closedAt === TTL exactly: purge condition is strictly '>', so this survives.
      const purged = purgeExpiredWorkItems(store, WORK_ITEM_TTL_MS);
      expect(purged).toBe(0);
      expect(store.get("proj", item.id)).toBeDefined();
    });

    it("purges a done item one ms past the TTL boundary", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 0 });
      closeWorkItem(store, item.id, "done", { now: 0 });
      const purged = purgeExpiredWorkItems(store, WORK_ITEM_TTL_MS + 1);
      expect(purged).toBe(1);
      expect(store.get("proj", item.id)).toBeUndefined();
    });

    it("purges an expired cancelled item the same as an expired done item", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 0 });
      closeWorkItem(store, item.id, "cancelled", { now: 0 });
      const purged = purgeExpiredWorkItems(store, WORK_ITEM_TTL_MS + 1);
      expect(purged).toBe(1);
    });

    it("leaves a recently-closed item alone", () => {
      const store = createWorkStore(dir);
      const item = createWorkItem(store, { project: "proj", title: "t", now: 0 });
      closeWorkItem(store, item.id, "done", { now: 0 });
      const purged = purgeExpiredWorkItems(store, WORK_ITEM_TTL_MS / 2);
      expect(purged).toBe(0);
      expect(store.get("proj", item.id)).toBeDefined();
    });

    it("purges across multiple projects in one pass", () => {
      const store = createWorkStore(dir);
      const a = createWorkItem(store, { project: "p1", title: "a", now: 0 });
      const b = createWorkItem(store, { project: "p2", title: "b", now: 0 });
      closeWorkItem(store, a.id, "done", { now: 0 });
      closeWorkItem(store, b.id, "done", { now: 0 });
      const purged = purgeExpiredWorkItems(store, WORK_ITEM_TTL_MS + 1);
      expect(purged).toBe(2);
      expect(store.listAll()).toEqual([]);
    });
  });
});
