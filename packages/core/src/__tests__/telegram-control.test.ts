import { describe, it, expect, vi, beforeEach } from "vitest";

const sendRequestMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("../protocol.js", () => ({
  sendRequest: sendRequestMock,
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { createIsCaptainAlive, createLaunch } from "../telegram/control.js";

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

// #520: the daemon's boot-if-down path shells out to `squadrant launch <project>`
// via createLaunch, but its stdout/stderr were discarded and a real failure
// (non-zero exit) was swallowed silently — ensureCaptainAlive just polled
// isAlive() for the full warmup window with zero diagnostic trail. createLaunch
// must now (1) pass --headless so the daemon's non-interactive launch actually
// boots instead of opening the cmux GUI app and exiting, (2) capture + log
// subprocess output for diagnostics, and (3) reject on failure so the daemon
// can tell launch didn't work.
describe("createLaunch (#520 daemon headless launch)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("invokes `launch <project> --headless` so the daemon's non-interactive call actually boots the captain", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, "", "");
    });
    const launch = createLaunch("/bin/squadrant-cli.js");
    await launch("squadrant");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual(["/bin/squadrant-cli.js", "launch", "squadrant", "--headless"]);
  });

  it("logs captured subprocess output on success", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, "  ✔ Workspace created\n", "");
    });
    const log = vi.fn();
    const launch = createLaunch("/bin/squadrant-cli.js", log);
    await launch("squadrant");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Workspace created"));
  });

  it("logs the captured output and rejects when the subprocess fails", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, callback) => {
      callback(new Error("Command failed"), "", "cmux spawn did not return a workspace id");
    });
    const log = vi.fn();
    const launch = createLaunch("/bin/squadrant-cli.js", log);
    await expect(launch("squadrant")).rejects.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cmux spawn did not return a workspace id"));
  });
});
