import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

const httpsGetMock = vi.fn();
vi.mock("node:https", () => ({
  default: { get: (...args: unknown[]) => httpsGetMock(...args) },
  get: (...args: unknown[]) => httpsGetMock(...args),
}));

const { isNewerVersion, isCacheStale, isUpdateCheckDisabled, formatUpdateNotice, fetchLatestVersion, checkForUpdate, notifyIfUpdateAvailable, UPDATE_CHECK_STATE_PATH } = await import(
  "../update-check.js"
);

function makeSocket() {
  const socket = new EventEmitter() as EventEmitter & { unref: () => void };
  socket.unref = vi.fn();
  return socket;
}

function makeReq() {
  const req = new EventEmitter() as EventEmitter & { setTimeout: (...a: unknown[]) => void; destroy: () => void };
  req.setTimeout = vi.fn();
  req.destroy = vi.fn(() => req.emit("error", new Error("destroyed")));
  return req;
}

function makeRes(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: (...a: unknown[]) => void; resume: () => void };
  res.statusCode = statusCode;
  res.setEncoding = vi.fn();
  res.resume = vi.fn();
  return res;
}

describe("isNewerVersion", () => {
  it("is true when latest is ahead", () => {
    expect(isNewerVersion("0.16.0", "0.15.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.15.0")).toBe(true);
    expect(isNewerVersion("0.15.1", "0.15.0")).toBe(true);
  });

  it("is false when up to date or behind", () => {
    expect(isNewerVersion("0.15.0", "0.15.0")).toBe(false);
    expect(isNewerVersion("0.14.9", "0.15.0")).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  it("renders the one-line actionable notice", () => {
    expect(formatUpdateNotice("0.16.0", "0.15.0")).toBe(
      "⬆ squadrant 0.16.0 available (you have 0.15.0) — npm i -g squadrant@latest",
    );
  });
});

describe("isCacheStale", () => {
  const now = 1_700_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;

  it("is stale when no state exists", () => {
    expect(isCacheStale(undefined, now)).toBe(true);
  });

  it("is fresh within the 24h success interval", () => {
    expect(isCacheStale({ lastChecked: now - 1000 }, now)).toBe(false);
  });

  it("is stale once the 24h success interval has elapsed", () => {
    expect(isCacheStale({ lastChecked: now - dayMs }, now)).toBe(true);
  });

  it("uses the shorter 1h backoff after a failed check, not the 24h success interval", () => {
    const state = { lastChecked: now - (hourMs + 1000), lastCheckFailed: true };
    expect(isCacheStale(state, now)).toBe(true);
    expect(isCacheStale({ ...state, lastChecked: now - 1000 }, now)).toBe(false);
    // Same age would still be "fresh" under the 24h success interval — confirms the
    // failure path is really using the shorter window, not accidentally reusing 24h.
    expect(isCacheStale({ lastChecked: now - (hourMs + 1000) }, now)).toBe(false);
  });
});

describe("isUpdateCheckDisabled", () => {
  it("is false by default", () => {
    expect(isUpdateCheckDisabled(undefined, {})).toBe(false);
  });

  it("honours defaults.updateCheck === false", () => {
    expect(isUpdateCheckDisabled({ defaults: { updateCheck: false } as any }, {})).toBe(true);
  });

  it("honours NO_UPDATE_NOTIFIER env var", () => {
    expect(isUpdateCheckDisabled(undefined, { NO_UPDATE_NOTIFIER: "1" })).toBe(true);
  });
});

describe("fetchLatestVersion (injected requestFn contract)", () => {
  it("returns the version on a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ version: "0.16.0" });
    await expect(fetchLatestVersion(fetchImpl as any, 1000)).resolves.toBe("0.16.0");
  });

  it("returns null when the request resolves null (non-200 upstream)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(null);
    await expect(fetchLatestVersion(fetchImpl as any, 1000)).resolves.toBeNull();
  });

  it("returns null fast when the request throws (offline)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const start = performance.now();
    await expect(fetchLatestVersion(fetchImpl as any, 1000)).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("returns null fast when the request hangs past the timeout, regardless of requestFn behavior", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const start = performance.now();
    await expect(fetchLatestVersion(fetchImpl as any, 50)).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("fetchLatestVersion (real node:https transport)", () => {
  it("parses the version from a 200 response", async () => {
    const req = makeReq();
    const res = makeRes(200);
    httpsGetMock.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      queueMicrotask(() => {
        cb(res);
        res.emit("data", JSON.stringify({ version: "0.16.0" }));
        res.emit("end");
      });
      return req;
    });
    await expect(fetchLatestVersion(undefined, 1000)).resolves.toBe("0.16.0");
  });

  it("resolves null and drains the response on a non-200 status", async () => {
    const req = makeReq();
    const res = makeRes(404);
    httpsGetMock.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      queueMicrotask(() => cb(res));
      return req;
    });
    await expect(fetchLatestVersion(undefined, 1000)).resolves.toBeNull();
    expect(res.resume).toHaveBeenCalled();
  });

  it("resolves null when the request errors", async () => {
    const req = makeReq();
    httpsGetMock.mockImplementation(() => {
      queueMicrotask(() => req.emit("error", new Error("ENOTFOUND")));
      return req;
    });
    await expect(fetchLatestVersion(undefined, 1000)).resolves.toBeNull();
  });

  it("unrefs the socket (not the request — ClientRequest itself has no unref()) so a hung connection can never hold the process open", async () => {
    const req = makeReq(); // never invokes the response callback — simulates a stalled connection
    const socket = makeSocket();
    httpsGetMock.mockImplementation(() => {
      queueMicrotask(() => req.emit("socket", socket));
      return req;
    });

    const start = performance.now();
    await expect(fetchLatestVersion(undefined, 50)).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
    expect(socket.unref).toHaveBeenCalled();
  });
});

describe("checkForUpdate", () => {
  const now = 1_700_000_000_000;

  it("prints a notice when behind and persists the fresh check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ version: "0.16.0" });
    const outcome = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(outcome.notice).toContain("0.16.0 available (you have 0.15.0)");
    expect(outcome.newState).toEqual({ lastChecked: now, latestKnown: "0.16.0", lastCheckFailed: false });
  });

  it("is silent when already up to date", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ version: "0.15.0" });
    const outcome = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(outcome.notice).toBeNull();
    expect(outcome.newState).toEqual({ lastChecked: now, latestKnown: "0.15.0", lastCheckFailed: false });
  });

  it("is silent and fast when the registry is unreachable, and caches the failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const start = performance.now();
    const outcome = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(performance.now() - start).toBeLessThan(500);
    expect(outcome.notice).toBeNull();
    expect(outcome.newState).toEqual({ lastChecked: now, lastCheckFailed: true });
  });

  it("makes no network call on a cache hit", async () => {
    const fetchImpl = vi.fn();
    const outcome = await checkForUpdate({
      currentVersion: "0.15.0",
      state: { lastChecked: now - 1000, latestKnown: "0.16.0" },
      now,
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.notice).toContain("0.16.0 available");
    expect(outcome.newState).toBeNull();
  });

  it("cache hit stays silent when the cached version is not newer", async () => {
    const fetchImpl = vi.fn();
    const outcome = await checkForUpdate({
      currentVersion: "0.15.0",
      state: { lastChecked: now - 1000, latestKnown: "0.15.0" },
      now,
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.notice).toBeNull();
  });

  it("a second check shortly after a failure makes no network call (failure backoff, not just success cache)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const first = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const tenMinutesLater = now + 10 * 60 * 1000;
    const second = await checkForUpdate({
      currentVersion: "0.15.0",
      state: first.newState!,
      now: tenMinutesLater,
      fetchImpl: fetchImpl as any,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1 — no new network call
    expect(second.notice).toBeNull();
    expect(second.newState).toBeNull();
  });

  it("retries after the failure backoff window elapses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ version: "0.16.0" });
    const failedState = { lastChecked: now, lastCheckFailed: true };
    const anHourAndAMinuteLater = now + 61 * 60 * 1000;
    const outcome = await checkForUpdate({
      currentVersion: "0.15.0",
      state: failedState,
      now: anHourAndAMinuteLater,
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.notice).toContain("0.16.0 available");
  });
});

describe("notifyIfUpdateAvailable", () => {
  const now = 1_700_000_000_000;

  it("writes state and prints the notice when behind", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ version: "0.16.0" });
    const readState = vi.fn().mockReturnValue(undefined);
    const writeState = vi.fn();
    const write = vi.fn();

    await notifyIfUpdateAvailable({
      config: undefined,
      currentVersion: "0.15.0",
      env: {},
      fetchImpl: fetchImpl as any,
      readState,
      writeState,
      write,
      now,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain("0.16.0 available");
    expect(writeState).toHaveBeenCalledWith({ lastChecked: now, latestKnown: "0.16.0", lastCheckFailed: false }, UPDATE_CHECK_STATE_PATH);
  });

  it("honours config opt-out with zero network calls", async () => {
    const fetchImpl = vi.fn();
    const write = vi.fn();
    await notifyIfUpdateAvailable({
      config: { defaults: { updateCheck: false } as any },
      currentVersion: "0.15.0",
      env: {},
      fetchImpl: fetchImpl as any,
      readState: vi.fn(),
      writeState: vi.fn(),
      write,
      now,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("honours NO_UPDATE_NOTIFIER env opt-out with zero network calls", async () => {
    const fetchImpl = vi.fn();
    const write = vi.fn();
    await notifyIfUpdateAvailable({
      config: undefined,
      currentVersion: "0.15.0",
      env: { NO_UPDATE_NOTIFIER: "1" },
      fetchImpl: fetchImpl as any,
      readState: vi.fn(),
      writeState: vi.fn(),
      write,
      now,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("an offline machine makes no network call on the very next invocation", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    let persisted: unknown;
    const writeState = vi.fn((state) => {
      persisted = state;
    });
    const readState = vi.fn(() => persisted as any);
    const write = vi.fn();

    await notifyIfUpdateAvailable({
      config: undefined,
      currentVersion: "0.15.0",
      env: {},
      fetchImpl: fetchImpl as any,
      readState,
      writeState,
      write,
      now,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await notifyIfUpdateAvailable({
      config: undefined,
      currentVersion: "0.15.0",
      env: {},
      fetchImpl: fetchImpl as any,
      readState,
      writeState,
      write,
      now: now + 5 * 60 * 1000, // 5 minutes later — still well within the 1h failure backoff
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second network call
    expect(write).not.toHaveBeenCalled();
  });

  it("never throws even if fetch and state I/O blow up", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const readState = vi.fn().mockImplementation(() => {
      throw new Error("fs boom");
    });
    await expect(
      notifyIfUpdateAvailable({
        config: undefined,
        currentVersion: "0.15.0",
        env: {},
        fetchImpl: fetchImpl as any,
        readState,
        writeState: vi.fn(),
        write: vi.fn(),
        now,
      }),
    ).resolves.toBeUndefined();
  });
});
