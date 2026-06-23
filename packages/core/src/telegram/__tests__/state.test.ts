import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  topicKey,
  loadState,
  saveState,
  setTopic,
  findProjectByThread,
  isNotifyActive,
  setNotify,
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
