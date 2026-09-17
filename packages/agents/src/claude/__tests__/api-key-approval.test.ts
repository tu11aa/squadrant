import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeApiKeyApproved } from "../api-key-approval.js";

const KEY = "sk-ant-abcdefghijklmnopqrstuvwx0123456789c1r63X2ikeuYCu1ewPVI";
const SUFFIX = KEY.slice(-20);

describe("ensureClaudeApiKeyApproved", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cp-claude-auth-"));
    file = join(dir, ".claude.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(doc: unknown): void {
    writeFileSync(file, JSON.stringify(doc));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function read(): any {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  it("moves a rejected key into approved (#775 precondition 3)", () => {
    write({ customApiKeyResponses: { approved: [], rejected: [SUFFIX] }, other: 1 });
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(true);
    const doc = read();
    expect(doc.customApiKeyResponses.rejected).toEqual([]);
    expect(doc.customApiKeyResponses.approved).toEqual([SUFFIX]);
    expect(doc.other).toBe(1); // unrelated fields preserved
    // Atomic write leaves no temp file behind.
    expect(readdirSync(dir)).toEqual([".claude.json"]);
  });

  it("adds an unlisted key to approved (avoids the interactive prompt)", () => {
    write({ customApiKeyResponses: { approved: ["other"], rejected: [] } });
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(true);
    expect(read().customApiKeyResponses.approved).toEqual(["other", SUFFIX]);
  });

  it("is a no-op when the key is already approved", () => {
    write({ customApiKeyResponses: { approved: [SUFFIX], rejected: [] } });
    const before = readFileSync(file, "utf8");
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("creates the responses block when absent", () => {
    write({ numStartups: 3 });
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(true);
    expect(read().customApiKeyResponses.approved).toEqual([SUFFIX]);
    expect(read().numStartups).toBe(3);
  });

  it("reports without throwing when the file is missing", () => {
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: join(dir, "nope.json") });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/no .*\.claude\.json/);
  });

  it("reports without throwing when the file is not valid JSON", () => {
    writeFileSync(file, "{ not json");
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/not valid JSON/);
  });

  it("ignores an empty key", () => {
    write({ customApiKeyResponses: { approved: [], rejected: [] } });
    const r = ensureClaudeApiKeyApproved("", { claudeJsonPath: file });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/empty api key/);
  });
});
