// packages/core/src/__tests__/launchd-foreign-install.test.ts
//
// #670: ensureDaemon must never seize a plist registered to a DIFFERENT,
// still-installed squadrant — that flip-flop is what caused the production
// daemon crash-loop. Integration-level tests (fs + child_process mocked)
// covering the guard end to end; parseProgramArgs/detectForeignInstall unit
// tests live in launchd.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  constants: { O_EXCL: 2048, O_CREAT: 512, O_WRONLY: 1 },
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { ensureDaemon, daemonEntryPath, renderPlist, _resetRestartInFlightForTest } from "../launchd.js";

const FOREIGN_ENTRY = "/Users/me/.nvm/versions/node/v24.6.0/lib/node_modules/squadrant/dist/squadrantd.js";

beforeEach(() => {
  vi.resetAllMocks();
  _resetRestartInFlightForTest();
  delete process.env.SQUADRANT_ROLE;
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(openSync).mockReturnValue(1 as unknown as number);
});

afterEach(() => {
  delete process.env.SQUADRANT_ROLE;
  vi.restoreAllMocks();
});

function resolveThisEntry(): string {
  vi.mocked(existsSync).mockReturnValue(true);
  return daemonEntryPath();
}

function stubExistsSync(opts: { lockExists?: boolean; foreignEntryExists?: boolean }): void {
  const { lockExists = false, foreignEntryExists = true } = opts;
  vi.mocked(existsSync).mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.includes("daemon.lock")) return lockExists;
    if (s === FOREIGN_ENTRY) return foreignEntryExists;
    return true; // this install's entry, the plist file, etc.
  });
}

describe("ensureDaemon — refuses a foreign-install plist (#670)", () => {
  it("leaves the plist untouched and never calls launchctl when a different, still-existing install owns it", () => {
    const thisEntry = resolveThisEntry();
    const currentPlistXml = renderPlist("/usr/local/bin/node", FOREIGN_ENTRY);
    stubExistsSync({ foreignEntryExists: true });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith(".plist")) return currentPlistXml;
      throw new Error(`unexpected readFileSync(${p})`);
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env.SQUADRANT_ROLE = "captain";
    ensureDaemon("/usr/local/bin/node");

    expect(writeFileSync).not.toHaveBeenCalled();
    // execFileSync IS called for `which <bin>` PATH resolution (unrelated to
    // the guard); what must never happen is a launchctl bootout/bootstrap/kickstart.
    const launchctlCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === "launchctl");
    expect(launchctlCalls).toEqual([]);
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain(FOREIGN_ENTRY);
    expect(printed).toContain(thisEntry);
  });

  it("still takes over when the registered entry differs but no longer exists on disk (stale — existing behavior preserved)", () => {
    resolveThisEntry();
    const currentPlistXml = renderPlist("/usr/local/bin/node", FOREIGN_ENTRY);
    stubExistsSync({ foreignEntryExists: false });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith(".plist")) return currentPlistXml;
      throw new Error(`unexpected readFileSync(${p})`);
    });

    process.env.SQUADRANT_ROLE = "captain";
    ensureDaemon("/usr/local/bin/node");

    expect(writeFileSync).toHaveBeenCalled();
    const launchctlCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === "launchctl");
    expect(launchctlCalls.length).toBeGreaterThan(0);
  });

  it("proceeds normally when the registered entry already matches this install (no conflict)", () => {
    const thisEntry = resolveThisEntry();
    const currentPlistXml = renderPlist("/usr/local/bin/node", thisEntry, "some-old-path");
    stubExistsSync({});
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith(".plist")) return currentPlistXml;
      throw new Error(`unexpected readFileSync(${p})`);
    });

    process.env.SQUADRANT_ROLE = "captain";
    ensureDaemon("/usr/local/bin/node");

    expect(writeFileSync).toHaveBeenCalled();
    const launchctlCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === "launchctl");
    expect(launchctlCalls.length).toBeGreaterThan(0);
  });
});
