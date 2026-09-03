import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSocksDir } from "../crew-spawn.js";

const mode = (p: string) => fs.statSync(p).mode & 0o777;

// Claude Code ≥ 2.1.259 refuses `--messaging-socket-path` unless the socket
// directory is exactly 0700 (live, 2026-09-03). A plain recursive mkdir under
// the default umask yields 755 and every claude captain/crew launch dies.
describe("ensureSocksDir", () => {
  it("creates a missing directory as 0700 regardless of umask", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "socks-")), "cc-socks");
    const prev = process.umask(0o022);
    try { ensureSocksDir(dir); } finally { process.umask(prev); }
    expect(mode(dir)).toBe(0o700);
  });

  it("tightens an existing 755 directory to 0700", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "socks-")), "cc-socks");
    fs.mkdirSync(dir, { mode: 0o755 });
    expect(mode(dir)).toBe(0o755);
    ensureSocksDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("leaves an already-0700 directory alone and does not disturb its contents", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "socks-")), "cc-socks");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "x.sock"), "");
    ensureSocksDir(dir);
    expect(mode(dir)).toBe(0o700);
    expect(fs.existsSync(path.join(dir, "x.sock"))).toBe(true);
  });
});
