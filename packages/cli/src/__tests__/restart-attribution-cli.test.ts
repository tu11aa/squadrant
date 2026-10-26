// Restart attribution on the CLI side: heal captain's kickstart -k logs first, and the
// squadrantdCall fallback names itself so an ensureDaemon it triggers is attributable.
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

beforeEach(() => { vi.resetAllMocks(); });

describe("restart attribution (cli)", () => {
  it("heal captain logs its attribution line before kickstart -k", () => {
    const order: string[] = [];
    vi.mocked(logRestartTrigger).mockImplementation((a, r) => { order.push(`trigger ${a} | ${r}`); });
    vi.mocked(execFileSync).mockImplementation(((_c: unknown, args?: readonly string[]) => { order.push(`launchctl ${args?.join(" ")}`); return ""; }) as unknown as typeof execFileSync);
    kickstartDaemonForHealCaptain();
    expect(order[0]).toBe("trigger kickstart-k | heal captain (reload liveness registry)");
    expect(order[1]).toMatch(/^launchctl kickstart -k /);
  });

  it("the squadrantdCall fallback passes its caller name to ensureDaemon", async () => {
    vi.mocked(sendRequest).mockRejectedValueOnce(new Error("control plane unavailable: cannot reach squadrantd socket")).mockResolvedValueOnce("ok");
    await expect(squadrantdCall({ kind: "list" })).resolves.toBe("ok");
    expect(ensureDaemon).toHaveBeenCalledWith(undefined, { caller: "squadrantdCall fallback" });
  });
});
