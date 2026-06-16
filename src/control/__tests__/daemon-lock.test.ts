// src/control/__tests__/daemon-lock.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  openSync: vi.fn(),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  constants: { O_EXCL: 2048, O_CREAT: 512, O_WRONLY: 1 },
}));

import { existsSync, readFileSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import {
  tryAcquireDaemonLock,
  releaseDaemonLock,
  daemonLockPath,
  _resetRestartInFlightForTest,
} from "../launchd.js";

const LOCK_PATH = daemonLockPath();

// Stub Atomics.wait to prevent real 50 ms sleeps in the retry loop.
const stubbedAtomics = { wait: vi.fn(() => "ok" as ReturnType<typeof Atomics.wait>) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("Atomics", stubbedAtomics);
  _resetRestartInFlightForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("daemonLockPath", () => {
  it("ends with daemon.lock inside .config/cockpit", () => {
    expect(LOCK_PATH).toMatch(/\.config[/\\]cockpit[/\\]daemon\.lock$/);
  });
});

describe("tryAcquireDaemonLock — no existing lock", () => {
  it("acquires lock and writes PID when no lock file exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(openSync).mockReturnValue(3 as unknown as number);

    const result = tryAcquireDaemonLock();

    expect(result).toBe(true);
    expect(openSync).toHaveBeenCalledOnce();
    expect(writeSync).toHaveBeenCalledWith(3, String(process.pid));
    expect(closeSync).toHaveBeenCalledWith(3);
  });

  it("does not call unlinkSync when no lock file exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(openSync).mockReturnValue(3 as unknown as number);

    tryAcquireDaemonLock();

    expect(unlinkSync).not.toHaveBeenCalled();
  });
});

describe("tryAcquireDaemonLock — stale lock (dead PID)", () => {
  it("removes stale lock when owning PID is dead and then acquires", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("99999");
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("kill ESRCH 99999"), { code: "ESRCH" });
    });
    vi.mocked(openSync).mockReturnValue(4 as unknown as number);

    const result = tryAcquireDaemonLock();

    expect(unlinkSync).toHaveBeenCalledWith(LOCK_PATH);
    expect(result).toBe(true);
  });

  it("removes lock with non-numeric PID and acquires", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-a-pid");
    vi.mocked(openSync).mockReturnValue(5 as unknown as number);

    const result = tryAcquireDaemonLock();

    expect(unlinkSync).toHaveBeenCalledWith(LOCK_PATH);
    expect(result).toBe(true);
  });

  it("removes lock with zero PID and acquires", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("0");
    vi.mocked(openSync).mockReturnValue(6 as unknown as number);

    const result = tryAcquireDaemonLock();

    expect(unlinkSync).toHaveBeenCalledWith(LOCK_PATH);
    expect(result).toBe(true);
  });
});

describe("tryAcquireDaemonLock — live process holds lock", () => {
  it("does not steal lock when owning PID is alive", () => {
    const livePid = process.pid + 1;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(String(livePid));
    vi.spyOn(process, "kill").mockImplementation((): true => true); // alive — no throw
    vi.mocked(openSync).mockImplementation(() => { throw new Error("EEXIST"); });

    const result = tryAcquireDaemonLock();

    expect(unlinkSync).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("retries before giving up when lock is held", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(openSync).mockImplementation(() => { throw new Error("EEXIST"); });

    tryAcquireDaemonLock();

    // 20 attempts, Atomics.wait called for the first 19 retries
    expect(stubbedAtomics.wait).toHaveBeenCalledTimes(19);
  });
});

describe("releaseDaemonLock", () => {
  it("calls unlinkSync on the lock path", () => {
    releaseDaemonLock();
    expect(unlinkSync).toHaveBeenCalledWith(LOCK_PATH);
  });

  it("does not throw when the lock file is already gone", () => {
    vi.mocked(unlinkSync).mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
    expect(() => releaseDaemonLock()).not.toThrow();
  });
});

describe("in-process restartInFlight dedup", () => {
  it("tryAcquireDaemonLock is not called on the second ensureDaemon invocation in the same process", async () => {
    // Import ensureDaemon after all mocks are set up.
    // We mock node:child_process to prevent real launchctl calls.
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn() }));

    // First call: no lock file, O_EXCL succeeds, execFileSync throws (daemonEntryPath)
    // so the function catches and returns. The flag is set to true.
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(openSync).mockReturnValue(7 as unknown as number);

    // Track how many times tryAcquireDaemonLock acquires the lock
    const acquireCalls: boolean[] = [];
    const originalOpen = vi.mocked(openSync);
    originalOpen.mockImplementation(() => {
      acquireCalls.push(true);
      return 7 as unknown as number;
    });

    const { ensureDaemon, _resetRestartInFlightForTest: reset } = await import("../launchd.js");
    reset();

    ensureDaemon();
    const firstAcquireCount = acquireCalls.length;

    // Second call in same process — restartInFlight is now true
    ensureDaemon();

    // Lock acquisition only happened once (the second call returned early)
    expect(acquireCalls.length).toBe(firstAcquireCount);

    reset(); // clean up for other tests
  });
});
