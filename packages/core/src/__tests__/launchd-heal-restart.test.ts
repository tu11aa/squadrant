// packages/core/src/__tests__/launchd-heal-restart.test.ts
//
// #729: `squadrant heal daemon` printed "✔ daemon kickstart complete" even
// when the plist already matched and no restart happened (a plain
// `launchctl kickstart` — no `-k` — is a no-op on a healthy daemon). The
// explicit heal path must always force `-k` and verify the pid actually
// changed before reporting success.
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
import { existsSync, readFileSync, openSync } from "node:fs";
import { getDaemonPid, forceKickstartAndVerify, reregisterDaemon, renderPlist, daemonEntryPath, buildDaemonPath, LABEL } from "../launchd.js";

function mockExecFileSync(
  handlers: (cmd: string, args: readonly string[]) => string | undefined,
): void {
  vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args?: readonly string[]) => {
    const result = handlers(String(cmd), args ?? []);
    if (result === undefined) throw new Error(`unhandled execFileSync(${cmd}, ${JSON.stringify(args)})`);
    return result;
  }) as unknown as typeof execFileSync);
}

describe("getDaemonPid", () => {
  beforeEach(() => { vi.mocked(execFileSync).mockReset(); });

  it("parses the pid out of `launchctl print` output", () => {
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        return "com.squadrant.daemon = {\n\tstate = running\n\tpid = 4242\n}\n";
      }
      return undefined;
    });
    expect(getDaemonPid(`gui/501/${LABEL}`)).toBe(4242);
  });

  it("returns null when the service isn't loaded (launchctl print throws)", () => {
    mockExecFileSync(() => { throw new Error("Could not find service"); });
    expect(getDaemonPid(`gui/501/${LABEL}`)).toBeNull();
  });
});

describe("forceKickstartAndVerify (#729)", () => {
  beforeEach(() => { vi.mocked(execFileSync).mockReset(); });

  it("always calls `kickstart -k` (never a plain kickstart)", () => {
    let printCalls = 0;
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        printCalls += 1;
        return `pid = ${printCalls === 1 ? 100 : 200}\n`;
      }
      if (cmd === "launchctl" && args[0] === "kickstart") return "";
      return undefined;
    });
    forceKickstartAndVerify(`gui/501/${LABEL}`, { pollAttempts: 1, pollDelayMs: 1 });
    const kickstartCall = vi.mocked(execFileSync).mock.calls.find((c) => c[0] === "launchctl" && (c[1] as string[])[0] === "kickstart");
    expect(kickstartCall?.[1]).toEqual(["kickstart", "-k", `gui/501/${LABEL}`]);
  });

  it("reports restarted=true once the pid changes", () => {
    let printCalls = 0;
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        printCalls += 1;
        return `pid = ${printCalls === 1 ? 100 : 200}\n`; // before=100, after=200
      }
      if (cmd === "launchctl" && args[0] === "kickstart") return "";
      return undefined;
    });
    const result = forceKickstartAndVerify(`gui/501/${LABEL}`, { pollAttempts: 3, pollDelayMs: 1 });
    expect(result).toEqual({ target: `gui/501/${LABEL}`, pidBefore: 100, pidAfter: 200, restarted: true });
  });

  it("reports restarted=false when the pid never changes (the #729 no-op)", () => {
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") return "pid = 100\n"; // same every time
      if (cmd === "launchctl" && args[0] === "kickstart") return "";
      return undefined;
    });
    const result = forceKickstartAndVerify(`gui/501/${LABEL}`, { pollAttempts: 2, pollDelayMs: 1 });
    expect(result).toEqual({ target: `gui/501/${LABEL}`, pidBefore: 100, pidAfter: 100, restarted: false });
  });

  // Code-review follow-up (#737): reregisterDaemon calls this right after a
  // bootout+bootstrap on program-arg drift — exactly today's upgrade case —
  // and `kickstart -k` racing bootout's still-unloading exit handler throws
  // (exit-113). A single failed attempt must not fail the whole heal.
  it("retries `kickstart -k` when it throws (racing bootout's exit handler) and succeeds on a later attempt", () => {
    let kickstartAttempts = 0;
    let printCalls = 0;
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        printCalls += 1;
        return `pid = ${printCalls === 1 ? 100 : 200}\n`;
      }
      if (cmd === "launchctl" && args[0] === "kickstart") {
        kickstartAttempts += 1;
        if (kickstartAttempts === 1) throw new Error("Operation now in progress (exit-113)");
        return "";
      }
      return undefined;
    });
    const result = forceKickstartAndVerify(`gui/501/${LABEL}`, {
      pollAttempts: 3, pollDelayMs: 1, kickstartRetries: 3, kickstartRetryDelayMs: 1,
    });
    expect(kickstartAttempts).toBe(2);
    expect(result).toEqual({ target: `gui/501/${LABEL}`, pidBefore: 100, pidAfter: 200, restarted: true });
  });

  it("throws once `kickstart -k` retries are exhausted", () => {
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "kickstart") throw new Error("still unloading (exit-113)");
      return undefined;
    });
    expect(() => forceKickstartAndVerify(`gui/501/${LABEL}`, { kickstartRetries: 2, kickstartRetryDelayMs: 1 })).toThrow(/still unloading/);
  });

  // #741: on the plist-drift path, `kickstart -k` can lose the race against
  // bootout's unload on every single retry — but launchd's own bootstrap
  // (RunAtLoad) may already have started the new instance by then. Exhausted
  // retries must not be reported as failure when the pid actually changed.
  it("reports restarted=true with a note when all `kickstart -k` retries throw but a new pid shows up", () => {
    let printCalls = 0;
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        printCalls += 1;
        return `pid = ${printCalls === 1 ? 100 : 200}\n`;
      }
      if (cmd === "launchctl" && args[0] === "kickstart") throw new Error("still unloading (exit-113)");
      return undefined;
    });
    const result = forceKickstartAndVerify(`gui/501/${LABEL}`, {
      pollAttempts: 3, pollDelayMs: 1, kickstartRetries: 2, kickstartRetryDelayMs: 1,
    });
    expect(result).toEqual({
      target: `gui/501/${LABEL}`,
      pidBefore: 100,
      pidAfter: 200,
      restarted: true,
      note: "kickstart -k refused; daemon restarted by bootstrap",
    });
  });

  it("still throws when all `kickstart -k` retries throw and the pid never changes", () => {
    mockExecFileSync((cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") return "pid = 100\n"; // same every time
      if (cmd === "launchctl" && args[0] === "kickstart") throw new Error("still unloading (exit-113)");
      return undefined;
    });
    expect(() => forceKickstartAndVerify(`gui/501/${LABEL}`, {
      pollAttempts: 2, pollDelayMs: 1, kickstartRetries: 2, kickstartRetryDelayMs: 1,
    })).toThrow(/still unloading/);
  });
});

describe("reregisterDaemon (#729 — heal daemon must never claim success on a no-op)", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(openSync).mockReset();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(openSync).mockReturnValue(1 as unknown as number); // daemon lock acquired
  });
  afterEach(() => vi.restoreAllMocks());

  // The plist ALREADY matches what this install would render — the exact
  // #729 repro condition ("plist mismatched" is not the bug; "plist matches"
  // is). buildDaemonPath is called AFTER "which" is mocked so it resolves to
  // the same sanitized PATH computeDaemonDrift will independently recompute.
  function stubMatchingPlist(thisEntry: string): void {
    const pathEnv = buildDaemonPath(process.env.PATH ?? "");
    const matching = renderPlist(process.execPath, thisEntry, pathEnv);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith(".plist")) return matching;
      throw new Error(`unexpected readFileSync(${p})`);
    });
  }

  it("still forces `kickstart -k` and succeeds when the plist already matches and the pid changes", () => {
    const thisEntry = daemonEntryPath();
    let printCalls = 0;
    mockExecFileSync((cmd, args) => {
      if (cmd === "which") throw new Error("not found");
      if (cmd === "launchctl" && args[0] === "print") {
        printCalls += 1;
        return `pid = ${printCalls === 1 ? 111 : 222}\n`;
      }
      if (cmd === "launchctl") return "";
      return undefined;
    });
    stubMatchingPlist(thisEntry);

    const result = reregisterDaemon(process.execPath, { pollAttempts: 3, pollDelayMs: 1 });

    expect(result.restarted).toBe(true);
    const kickstartCall = vi.mocked(execFileSync).mock.calls.find((c) => c[0] === "launchctl" && (c[1] as string[])[0] === "kickstart");
    expect(kickstartCall?.[1]).toContain("-k");
  });

  it("throws (never reports success) when the plist matches AND the pid does not change", () => {
    const thisEntry = daemonEntryPath();
    mockExecFileSync((cmd, args) => {
      if (cmd === "which") throw new Error("not found");
      if (cmd === "launchctl" && args[0] === "print") return "pid = 111\n"; // never changes
      if (cmd === "launchctl") return "";
      return undefined;
    });
    stubMatchingPlist(thisEntry);

    expect(() => reregisterDaemon(process.execPath, { pollAttempts: 2, pollDelayMs: 1 })).toThrow(/did not restart/);
  });
});
