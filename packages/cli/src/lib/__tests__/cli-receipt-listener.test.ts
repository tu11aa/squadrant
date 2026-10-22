// #1033: `crew send` must not die on a stale or concurrent receipt socket.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliReceiptListener } from "../captain-channel-factory.js";

const dirs: string[] = [];
function tmpDir(): string {
  // UDS paths are length-limited (~104 on macOS) — keep it short.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("createCliReceiptListener (#1033)", () => {
  it("advertises a per-pid address", () => {
    const dir = tmpDir();
    expect(createCliReceiptListener({ dir, pid: 4242 }).address).toBe(`uds:${dir}/squadrantd-cli-4242.sock`);
  });

  it("a stale file at the path does not break start", async () => {
    const dir = tmpDir();
    fs.writeFileSync(`${dir}/squadrantd-cli-7.sock`, "");
    const l = createCliReceiptListener({ dir, pid: 7 });
    await expect(l.start()).resolves.toBeUndefined();
    l.stop();
  });

  it("two listeners with different pids do not collide", async () => {
    const dir = tmpDir();
    const a = createCliReceiptListener({ dir, pid: 1 });
    const b = createCliReceiptListener({ dir, pid: 2 });
    await a.start();
    await expect(b.start()).resolves.toBeUndefined();
    a.stop();
    b.stop();
  });

  it("stop() removes the socket file", async () => {
    const dir = tmpDir();
    const l = createCliReceiptListener({ dir, pid: 3 });
    await l.start();
    expect(fs.existsSync(`${dir}/squadrantd-cli-3.sock`)).toBe(true);
    l.stop();
    expect(fs.existsSync(`${dir}/squadrantd-cli-3.sock`)).toBe(false);
  });
});
