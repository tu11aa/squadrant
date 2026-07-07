import { describe, it, expect, vi, beforeEach } from "vitest";

const sendRequestMock = vi.hoisted(() => vi.fn());

vi.mock("../protocol.js", () => ({
  sendRequest: sendRequestMock,
}));

import { createIsCaptainAlive } from "../telegram/control.js";

// #517: Telegram auto-launch never fires because isAlive() misreports a down
// captain as alive. Captain rows only ever report "alive" | "stopped" | "unknown"
// (see liveness.ts projectHealth) — "stopped" means the workspace was closed.
describe("createIsCaptainAlive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const isAlive = createIsCaptainAlive("/tmp/fake.sock");

  it("returns true when the captain row reports state 'alive'", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "squadrant", state: "alive" },
    ]);
    expect(await isAlive("squadrant")).toBe(true);
  });

  it("returns false when the captain workspace was closed (state 'stopped' = down)", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "squadrant", state: "stopped" },
    ]);
    expect(await isAlive("squadrant")).toBe(false);
  });

  it("returns false when the captain state is unknown", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "squadrant", state: "unknown" },
    ]);
    expect(await isAlive("squadrant")).toBe(false);
  });

  it("returns false when there is no captain row at all", async () => {
    sendRequestMock.mockResolvedValue([]);
    expect(await isAlive("squadrant")).toBe(false);
  });

  it("returns false when the health request throws", async () => {
    sendRequestMock.mockRejectedValue(new Error("socket unreachable"));
    expect(await isAlive("squadrant")).toBe(false);
  });
});
