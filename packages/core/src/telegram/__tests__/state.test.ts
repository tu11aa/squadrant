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
  it("returns {offset:0, topics:{}} when the file is missing", () => {
    expect(loadState(root)).toEqual({ offset: 0, topics: {} });
  });

  it("round-trips offset and topics through save → load", () => {
    const s: TelegramState = { offset: 42, topics: { "squadrant::project": 7 } };
    saveState(root, s);
    expect(loadState(root)).toEqual(s);
  });

  it("returns the default state when the file is corrupt", () => {
    fs.writeFileSync(path.join(root, "telegram-state.json"), "{not json");
    expect(loadState(root)).toEqual({ offset: 0, topics: {} });
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
    saveState(root, { offset: 5, topics: {} });
    setTopic(root, "squadrant", 100);
    expect(loadState(root).offset).toBe(5);
  });
});
