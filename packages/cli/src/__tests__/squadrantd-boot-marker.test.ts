// #535: the daemon must write a greppable boot marker on startup and a
// matching exit marker on stop() — a restart must never be inferred from
// process START time alone.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSquadrantd } from "../squadrantd.js";

describe("squadrantd boot/exit markers (#535)", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("logs a boot marker with pid/version/socket on startup", () => {
    dir = mkdtempSync(join(tmpdir(), "boot-marker-"));
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: join(dir, "c.sock"), sweepMs: 0 });
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      const bootLine = lines.find((l) => /\[squadrantd\].*\bboot pid=\d+ version=\S+ socket=\S+/.test(l));
      expect(bootLine).toBeDefined();
      expect(bootLine).toContain(`pid=${process.pid}`);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });

  it("logs an exit marker carrying the shutdown reason on stop()", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-marker-"));
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: join(dir, "c.sock"), sweepMs: 0 });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await handle.stop("SIGTERM");
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      const exitLine = lines.find((l) => /\bexit pid=\d+ reason=SIGTERM\b/.test(l));
      expect(exitLine).toBeDefined();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("writes the exit marker synchronously — before any awaited teardown resolves", () => {
    dir = mkdtempSync(join(tmpdir(), "boot-marker-"));
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: join(dir, "c.sock"), sweepMs: 0 });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Do NOT await — simulates a caller that fires-and-forgets (the historical
      // bug: SIGTERM handler called h.stop() then process.exit() immediately).
      void handle.stop("SIGTERM");
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /\bexit pid=\d+ reason=SIGTERM\b/.test(l))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("defaults the exit reason to 'requested' when the caller passes none", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-marker-"));
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: join(dir, "c.sock"), sweepMs: 0 });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await handle.stop();
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /\bexit pid=\d+ reason=requested\b/.test(l))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
