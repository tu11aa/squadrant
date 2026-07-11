import { describe, it, expect, vi } from "vitest";
import {
  isNewerVersion,
  isCacheStale,
  isUpdateCheckDisabled,
  formatUpdateNotice,
  fetchLatestVersion,
  checkForUpdate,
  notifyIfUpdateAvailable,
  UPDATE_CHECK_STATE_PATH,
} from "../update-check.js";

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

  it("is stale when no state exists", () => {
    expect(isCacheStale(undefined, now)).toBe(true);
  });

  it("is fresh within the interval", () => {
    expect(isCacheStale({ lastChecked: now - 1000 }, now)).toBe(false);
  });

  it("is stale once the interval has elapsed", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    expect(isCacheStale({ lastChecked: now - dayMs }, now)).toBe(true);
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

describe("fetchLatestVersion", () => {
  it("returns the version on a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "0.16.0" }) });
    await expect(fetchLatestVersion(fetchImpl as any, 1000)).resolves.toBe("0.16.0");
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchLatestVersion(fetchImpl as any, 1000)).resolves.toBeNull();
  });

  it("returns null fast when the fetch throws (offline)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const start = performance.now();
    await expect(fetchLatestVersion(fetchImpl as any, 1000)).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("returns null fast when the fetch hangs past the timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const start = performance.now();
    await expect(fetchLatestVersion(fetchImpl as any, 50)).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("checkForUpdate", () => {
  const now = 1_700_000_000_000;

  it("prints a notice when behind and persists the fresh check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "0.16.0" }) });
    const outcome = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(outcome.notice).toContain("0.16.0 available (you have 0.15.0)");
    expect(outcome.newState).toEqual({ lastChecked: now, latestKnown: "0.16.0" });
  });

  it("is silent when already up to date", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "0.15.0" }) });
    const outcome = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(outcome.notice).toBeNull();
    expect(outcome.newState).toEqual({ lastChecked: now, latestKnown: "0.15.0" });
  });

  it("is silent and fast when the registry is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const start = performance.now();
    const outcome = await checkForUpdate({ currentVersion: "0.15.0", state: undefined, now, fetchImpl: fetchImpl as any });
    expect(performance.now() - start).toBeLessThan(500);
    expect(outcome.notice).toBeNull();
    expect(outcome.newState).toBeNull();
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
});

describe("notifyIfUpdateAvailable", () => {
  const now = 1_700_000_000_000;

  it("writes state and prints the notice when behind", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "0.16.0" }) });
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
    expect(writeState).toHaveBeenCalledWith({ lastChecked: now, latestKnown: "0.16.0" }, UPDATE_CHECK_STATE_PATH);
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
