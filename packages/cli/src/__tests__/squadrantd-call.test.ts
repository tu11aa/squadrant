// squadrantdCall used to treat ANY failure as "daemon down": a 5s timeout on a busy
// daemon (or a daemon-reported error) ran ensureDaemon and re-sent the same request up
// to three times — a daemon that was merely slow got the request twice (an extra
// message / spawn) and a captain-role caller could reconcile the daemon for nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: vi.fn() }));
vi.mock("@squadrant/core", async (orig) => ({
  ...(await orig<typeof import("@squadrant/core")>()),
  sendRequest: vi.fn(),
  ensureDaemon: vi.fn(),
  logRestartTrigger: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { sendRequest, ensureDaemon, logRestartTrigger } from "@squadrant/core";
import { squadrantdCall } from "../commands/crew-control.js";
import { kickstartDaemonForHealCaptain } from "../commands/heal.js";

const UNREACHABLE = new Error("control plane unavailable: cannot reach squadrantd socket");

beforeEach(() => { vi.resetAllMocks(); });

describe("squadrantdCall", () => {
  it("a timeout (busy daemon) is thrown as-is: no ensureDaemon, no re-send", async () => {
    vi.mocked(sendRequest).mockRejectedValue(new Error("control plane unavailable: request timed out"));
    await expect(squadrantdCall({ kind: "event" })).rejects.toThrow(/timed out/);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it("a daemon-reported error is thrown as-is: no ensureDaemon, no re-send", async () => {
    vi.mocked(sendRequest).mockRejectedValue(new Error("task not found"));
    await expect(squadrantdCall({ kind: "status" })).rejects.toThrow("task not found");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it("an unreachable socket still self-heals and retries, naming the caller", async () => {
    vi.mocked(sendRequest).mockRejectedValueOnce(UNREACHABLE).mockResolvedValueOnce("ok");
    await expect(squadrantdCall({ kind: "list" })).resolves.toBe("ok");
    expect(ensureDaemon).toHaveBeenCalledWith(undefined, { caller: "squadrantdCall fallback (socket unreachable)" });
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });
});

describe("heal captain kickstart", () => {
  it("logs its attribution line before kickstart -k", () => {
    const order: string[] = [];
    vi.mocked(logRestartTrigger).mockImplementation((a, r) => { order.push(`trigger ${a} | ${r}`); });
    vi.mocked(execFileSync).mockImplementation(((_c: unknown, args?: readonly string[]) => { order.push(`launchctl ${args?.join(" ")}`); return ""; }) as unknown as typeof execFileSync);
    kickstartDaemonForHealCaptain();
    expect(order[0]).toBe("trigger kickstart-k | heal captain (reload liveness registry)");
    expect(order[1]).toMatch(/^launchctl kickstart -k /);
  });
});
