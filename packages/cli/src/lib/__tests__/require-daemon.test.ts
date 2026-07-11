import { describe, it, expect, vi } from "vitest";
import { requireDaemon } from "../require-daemon.js";
import { isDaemonSocketLive } from "@squadrant/core";

vi.mock("@squadrant/core", () => ({
  isDaemonSocketLive: vi.fn(),
}));

describe("requireDaemon", () => {
  it("resolves successfully if socket is live", async () => {
    vi.mocked(isDaemonSocketLive).mockResolvedValue(true);
    await expect(requireDaemon("dummy.sock")).resolves.toBeUndefined();
    expect(isDaemonSocketLive).toHaveBeenCalledWith("dummy.sock");
  });

  it("throws an error if socket is dead", async () => {
    vi.mocked(isDaemonSocketLive).mockResolvedValue(false);
    await expect(requireDaemon("dummy.sock")).rejects.toThrow(
      "daemon not running — message NOT delivered. Start it with 'squadrant launch <project>'."
    );
  });
});
