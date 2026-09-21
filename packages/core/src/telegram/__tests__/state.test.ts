import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  topicKey,
  loadState,
  saveState,
  setTopic,
  setLastUserId,
  findProjectByThread,
  isNotifyActive,
  setNotify,
  loadPending,
  setPending,
  clearPending,
  markPendingWarned,
  notePaneScreen,
  pruneTopics,
  type TelegramState,
} from "../state.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-state-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("topicKey", () => {
  it("defaults scope to 'project'", () => {
    expect(topicKey("squadrant")).toBe("squadrant::project");
  });
  it("honors an explicit scope", () => {
    expect(topicKey("squadrant", "crew:t1")).toBe("squadrant::crew:t1");
  });
});

describe("loadState / saveState", () => {
  it("returns {offset:0, topics:{}, notify:{}} when the file is missing", () => {
    expect(loadState(root)).toEqual({ offset: 0, topics: {}, notify: {} });
  });

  it("round-trips offset and topics through save → load", () => {
    const s: TelegramState = { offset: 42, topics: { "squadrant::project": 7 }, notify: {} };
    saveState(root, s);
    expect(loadState(root)).toEqual(s);
  });

  it("returns the default state when the file is corrupt", () => {
    fs.writeFileSync(path.join(root, "telegram-state.json"), "{not json");
    expect(loadState(root)).toEqual({ offset: 0, topics: {}, notify: {} });
  });
});

describe("setTopic / findProjectByThread", () => {
  it("setTopic persists a (project, scope) → topicId mapping resolvable by thread", () => {
    setTopic(root, "squadrant", 100);
    expect(loadState(root).topics).toEqual({ "squadrant::project": 100 });
    expect(findProjectByThread(root, 100)).toEqual({ project: "squadrant", scope: "project" });
  });

  it("preserves an explicit scope through the round-trip", () => {
    setTopic(root, "squadrant", 200, "crew:t1");
    expect(findProjectByThread(root, 200)).toEqual({ project: "squadrant", scope: "crew:t1" });
  });

  it("returns null for an unknown thread", () => {
    setTopic(root, "squadrant", 100);
    expect(findProjectByThread(root, 999)).toBeNull();
  });

  it("setTopic preserves the existing offset", () => {
    saveState(root, { offset: 5, topics: {}, notify: {} });
    setTopic(root, "squadrant", 100);
    expect(loadState(root).offset).toBe(5);
  });
});

describe("notify state", () => {
  it("defaults to muted (absent key → false)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    expect(isNotifyActive(dir, "squadrant")).toBe(false);
  });

  it("loadState defaults notify to {} when file lacks it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    fs.writeFileSync(path.join(dir, "telegram-state.json"), JSON.stringify({ offset: 3, topics: {} }));
    expect(loadState(dir).notify).toEqual({});
  });

  it("setNotify round-trips through save/load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    setNotify(dir, "squadrant", true);
    expect(isNotifyActive(dir, "squadrant")).toBe(true);
    setNotify(dir, "squadrant", false);
    expect(isNotifyActive(dir, "squadrant")).toBe(false);
  });

  it("setNotify preserves offset and topics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    setTopic(dir, "squadrant", 7);
    setNotify(dir, "squadrant", true);
    const s = loadState(dir);
    expect(s.topics).toEqual({ "squadrant::project": 7 });
    expect(s.notify).toEqual({ squadrant: true });
  });
});

describe("pending reply (#838/#839)", () => {
  it("is empty when the file is missing", () => {
    expect(loadPending(root)).toEqual({});
  });

  it("setPending round-trips threadId + startedAt", () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1000 });
    expect(loadPending(root)).toEqual({ demo: { threadId: 7, startedAt: 1000 } });
  });

  it("setPending preserves offset, topics, notify, lastUserId", () => {
    saveState(root, { offset: 7, topics: { "sq::project": 1 }, notify: { sq: true }, lastUserId: 9 });
    setPending(root, "sq", { threadId: 1, startedAt: 5 });
    const s = loadState(root);
    expect(s.offset).toBe(7);
    expect(s.topics).toEqual({ "sq::project": 1 });
    expect(s.notify).toEqual({ sq: true });
    expect(s.lastUserId).toBe(9);
  });

  it("clearPending removes the entry — the single captain-replied signal", () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1000 });
    clearPending(root, "demo");
    expect(loadPending(root)).toEqual({});
  });

  it("clearPending for an unknown project does not write", () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1000 });
    const before = fs.readFileSync(path.join(root, "telegram-state.json"), "utf8");
    clearPending(root, "other");
    expect(fs.readFileSync(path.join(root, "telegram-state.json"), "utf8")).toBe(before);
  });

  it("markPendingWarned stamps warnedAt without dropping threadId/startedAt", () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1000 });
    markPendingWarned(root, "demo", 2000);
    expect(loadPending(root).demo).toEqual({ threadId: 7, startedAt: 1000, warnedAt: 2000 });
  });

  it("markPendingWarned is a no-op when nothing is pending", () => {
    markPendingWarned(root, "demo", 2000);
    expect(loadPending(root)).toEqual({});
  });

  it("notePaneScreen records the hash and returns undefined on first sight", () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1000 });
    expect(notePaneScreen(root, "demo", "abc123", 2000)).toBeUndefined();
    expect(loadPending(root).demo).toMatchObject({ paneHash: "abc123", paneChangedAt: 2000 });
  });

  it("notePaneScreen returns ms since the screen last CHANGED", () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1000 });
    notePaneScreen(root, "demo", "abc123", 2000);
    // Same screen → age accumulates, changedAt stays put.
    expect(notePaneScreen(root, "demo", "abc123", 9000)).toBe(7000);
    expect(loadPending(root).demo?.paneChangedAt).toBe(2000);
    // Changed screen → clock resets, age is undefined again.
    expect(notePaneScreen(root, "demo", "def456", 10000)).toBeUndefined();
    expect(loadPending(root).demo?.paneChangedAt).toBe(10000);
  });

  it("notePaneScreen preserves threadId, startedAt and warnedAt", () => {
    setPending(root, "demo", { threadId: 9, startedAt: 1000, warnedAt: 1500 });
    notePaneScreen(root, "demo", "abc123", 2000);
    expect(loadPending(root).demo).toMatchObject({ threadId: 9, startedAt: 1000, warnedAt: 1500 });
  });

  it("notePaneScreen does nothing when no delivery is pending", () => {
    expect(notePaneScreen(root, "demo", "abc123", 2000)).toBeUndefined();
    expect(loadPending(root)).toEqual({});
  });
});

describe("pruneTopics (#321)", () => {
  it("drops links whose project is no longer kept", () => {
    setTopic(root, "alive", 1);
    setTopic(root, "dead", 2);
    expect(pruneTopics(root, (p) => p === "alive")).toEqual(["dead::project"]);
    expect(loadState(root).topics).toEqual({ "alive::project": 1 });
  });

  it("prunes an explicit scope with its project", () => {
    setTopic(root, "dead", 2, "crew:t1");
    expect(pruneTopics(root, () => false)).toEqual(["dead::crew:t1"]);
    expect(loadState(root).topics).toEqual({});
  });

  it("keeps every scope of a project that survives", () => {
    setTopic(root, "alive", 1);
    setTopic(root, "alive", 2, "crew:t1");
    expect(pruneTopics(root, (p) => p === "alive")).toEqual([]);
    expect(loadState(root).topics).toEqual({ "alive::project": 1, "alive::crew:t1": 2 });
  });

  it("is a no-op write when nothing is stale", () => {
    setTopic(root, "alive", 1);
    const before = fs.readFileSync(path.join(root, "telegram-state.json"), "utf8");
    expect(pruneTopics(root, () => true)).toEqual([]);
    expect(fs.readFileSync(path.join(root, "telegram-state.json"), "utf8")).toBe(before);
  });

  it("preserves offset, notify and lastUserId", () => {
    saveState(root, { offset: 7, topics: { "dead::project": 2 }, notify: { dead: true }, lastUserId: 9 });
    pruneTopics(root, () => false);
    const s = loadState(root);
    expect(s.offset).toBe(7);
    expect(s.notify).toEqual({ dead: true });
    expect(s.lastUserId).toBe(9);
  });
});

describe("lastUserId", () => {
  it("is absent (undefined) when the file is missing", () => {
    expect(loadState(root).lastUserId).toBeUndefined();
  });

  it("setLastUserId round-trips through save/load", () => {
    setLastUserId(root, 42);
    expect(loadState(root).lastUserId).toBe(42);
  });

  it("setLastUserId preserves offset, topics, and notify", () => {
    saveState(root, { offset: 7, topics: { "sq::project": 1 }, notify: { sq: true } });
    setLastUserId(root, 99);
    const s = loadState(root);
    expect(s.offset).toBe(7);
    expect(s.topics).toEqual({ "sq::project": 1 });
    expect(s.notify).toEqual({ sq: true });
    expect(s.lastUserId).toBe(99);
  });

  it("loadState does not set lastUserId key when field is absent in the file", () => {
    saveState(root, { offset: 0, topics: {}, notify: {} });
    expect(Object.prototype.hasOwnProperty.call(loadState(root), "lastUserId")).toBe(false);
  });
});
