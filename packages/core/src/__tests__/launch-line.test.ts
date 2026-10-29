import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedLaunchLine, MAX_INLINE_LAUNCH_BYTES } from "../launch-line.js";

const dir = () => join(mkdtempSync(join(tmpdir(), "launch-line-")), "launch");

describe("boundedLaunchLine (#1090)", () => {
  it("passes a short line through untouched and writes nothing", () => {
    const d = dir();
    const line = "cd '/tmp/x' && FOO=1 nice -n 10 claude -n x";
    expect(boundedLaunchLine(line, d)).toBe(line);
    expect(existsSync(d)).toBe(false);
  });

  it("replaces a long line with a short eval of a 0600 file holding the exact line", () => {
    const d = dir();
    const line = `cd '${"/very/long/path".repeat(40)}' && FOO=1 nice -n 10 claude --mcp-config '{"a":"${"x".repeat(900)}"}'`;
    expect(Buffer.byteLength(line)).toBeGreaterThan(1024);
    const typed = boundedLaunchLine(line, d);
    expect(Buffer.byteLength(typed)).toBeLessThan(MAX_INLINE_LAUNCH_BYTES);
    const [file] = readdirSync(d);
    expect(statSync(join(d, file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d, file), "utf8")).toBe(`${line}\n`);
  });

  it("stays bounded however long the line is, and the shell evaluates the identical text then deletes the file", () => {
    const d = dir();
    const out = join(d, "..", "out.txt");
    const payload = "y".repeat(5000);
    const typed = boundedLaunchLine(`printf %s '${payload}' > '${out}'`, d);
    expect(Buffer.byteLength(typed)).toBeLessThan(MAX_INLINE_LAUNCH_BYTES);
    execFileSync("sh", ["-c", typed]);
    expect(readFileSync(out, "utf8")).toBe(payload);
    expect(readdirSync(d)).toEqual([]); // env values never linger on disk
  });
});
