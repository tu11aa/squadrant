// Unit tests for session-freshness — run with no real processes.
// Uses real fs on a temp dir per test so assertions are deterministic
// without complex mocking.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadSessions,
  saveSessions,
  computeTemplateHash,
  shouldStartFresh,
  recordSession,
} from "../session-freshness.js";

let tmpDir: string;
let sessionsPath: string;
let templatesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-sf-test-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
  templatesDir = path.join(tmpDir, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── loadSessions / saveSessions ───────────────────────────────────────────────

describe("loadSessions", () => {
  it("returns empty workspaces when file does not exist", () => {
    expect(loadSessions(sessionsPath)).toEqual({ workspaces: {} });
  });

  it("parses a valid sessions file", () => {
    const data = { workspaces: { "ws-1": { lastLaunched: "2026-01-01", templateHash: "abc" } } };
    fs.writeFileSync(sessionsPath, JSON.stringify(data));
    expect(loadSessions(sessionsPath)).toEqual(data);
  });

  it("returns empty workspaces on invalid JSON", () => {
    fs.writeFileSync(sessionsPath, "not json");
    expect(loadSessions(sessionsPath)).toEqual({ workspaces: {} });
  });
});

describe("saveSessions", () => {
  it("writes sessions to disk and creates parent dirs", () => {
    const nested = path.join(tmpDir, "sub", "sessions.json");
    const data = { workspaces: { ws: { lastLaunched: "2026-06-01", templateHash: "xyz" } } };
    saveSessions(nested, data);
    expect(JSON.parse(fs.readFileSync(nested, "utf-8"))).toEqual(data);
  });
});

// ── computeTemplateHash ───────────────────────────────────────────────────────

describe("computeTemplateHash", () => {
  it("returns a 16-char hex string", () => {
    const h = computeTemplateHash("captain", templatesDir);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces the same hash when no template files exist (stable empty hash)", () => {
    const h1 = computeTemplateHash("captain", templatesDir);
    const h2 = computeTemplateHash("captain", templatesDir);
    expect(h1).toBe(h2);
  });

  it("changes hash when the role template file changes", () => {
    const roleFile = path.join(templatesDir, "captain.claude.md");
    fs.writeFileSync(roleFile, "v1");
    const h1 = computeTemplateHash("captain", templatesDir);
    fs.writeFileSync(roleFile, "v2");
    const h2 = computeTemplateHash("captain", templatesDir);
    expect(h1).not.toBe(h2);
  });

  it("also hashes plugin skills when the dir exists", () => {
    const skillsDir = path.join(templatesDir, "..", "plugin", "skills", "my-skill");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "v1");
    const h1 = computeTemplateHash("captain", templatesDir);
    fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "v2");
    const h2 = computeTemplateHash("captain", templatesDir);
    expect(h1).not.toBe(h2);
  });
});

// ── shouldStartFresh ──────────────────────────────────────────────────────────

describe("shouldStartFresh", () => {
  const opts = () => ({ sessionsPath, templatesDir });
  const today = new Date().toISOString().slice(0, 10);

  it("returns fresh=true with 'first launch' on missing record", () => {
    const result = shouldStartFresh("ws-new", "captain", opts());
    expect(result).toEqual({ fresh: true, reason: "first launch" });
  });

  it("returns fresh=true when lastLaunched is a different day", () => {
    const hash = computeTemplateHash("captain", templatesDir);
    saveSessions(sessionsPath, { workspaces: { "ws-1": { lastLaunched: "2000-01-01", templateHash: hash } } });
    const result = shouldStartFresh("ws-1", "captain", opts());
    expect(result).toEqual({ fresh: true, reason: "new day — starting fresh session" });
  });

  it("returns fresh=true when templateHash has changed", () => {
    saveSessions(sessionsPath, { workspaces: { "ws-1": { lastLaunched: today, templateHash: "stale-hash" } } });
    const result = shouldStartFresh("ws-1", "captain", opts());
    expect(result.fresh).toBe(true);
    expect(result.reason).toBe("template instructions updated");
  });

  it("returns fresh=false when same day and same hash", () => {
    const hash = computeTemplateHash("captain", templatesDir);
    saveSessions(sessionsPath, { workspaces: { "ws-1": { lastLaunched: today, templateHash: hash } } });
    const result = shouldStartFresh("ws-1", "captain", opts());
    expect(result).toEqual({ fresh: false });
  });
});

// ── recordSession ─────────────────────────────────────────────────────────────

describe("recordSession", () => {
  it("writes today's date and current hash for the workspace", () => {
    const today = new Date().toISOString().slice(0, 10);
    recordSession("ws-1", "captain", { sessionsPath, templatesDir });
    const sessions = loadSessions(sessionsPath);
    expect(sessions.workspaces["ws-1"].lastLaunched).toBe(today);
    expect(sessions.workspaces["ws-1"].templateHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("preserves existing workspaces when recording a new one", () => {
    const existing = { workspaces: { "ws-old": { lastLaunched: "2026-01-01", templateHash: "abc" } } };
    saveSessions(sessionsPath, existing);
    recordSession("ws-new", "captain", { sessionsPath, templatesDir });
    const sessions = loadSessions(sessionsPath);
    expect(sessions.workspaces["ws-old"]).toBeDefined();
    expect(sessions.workspaces["ws-new"]).toBeDefined();
  });
});
