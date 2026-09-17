import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captainRecordPath, readCaptainAddress, writeCaptainAddress, sameDirectory,
} from "../captain-record.js";

function stateRoot() { return mkdtempSync(join(tmpdir(), "cap-rec-")); }

describe("captain-address record", () => {
  it("round-trips an opencode address", () => {
    const root = stateRoot();
    const addr = { agent: "opencode", port: 51220, sessionId: "ses_x", directory: "/tmp/p", launchedAt: "2026-09-17T00:00:00.000Z" };
    writeCaptainAddress(root, "demo", addr);
    expect(readCaptainAddress(root, "demo")).toEqual(addr);
  });

  it("returns null for a missing or malformed record", () => {
    const root = stateRoot();
    expect(readCaptainAddress(root, "nope")).toBeNull();
    const p = captainRecordPath(root, "bad");
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(p, "{not json");
    expect(readCaptainAddress(root, "bad")).toBeNull();
    writeFileSync(p, JSON.stringify({ sessionId: "ses_x" }));  // no agent
    expect(readCaptainAddress(root, "bad")).toBeNull();
  });

  it("sameDirectory compares realpaths, not literal strings", () => {
    const base = mkdtempSync(join(tmpdir(), "cap-dir-"));
    const real = join(base, "real"); const link = join(base, "link");
    mkdirSync(real); symlinkSync(real, link);
    expect(realpathSync(link)).not.toBe(link);            // guard: the test is meaningful
    expect(sameDirectory(realpathSync(real), link)).toBe(true);
    expect(sameDirectory("/tmp/a", "/tmp/b")).toBe(false);
    expect(sameDirectory(undefined, real)).toBe(false);
  });
});
