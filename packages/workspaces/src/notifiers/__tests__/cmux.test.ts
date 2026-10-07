import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCmuxNotifier } from "../cmux.js";

const execMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@squadrant/shared")>()),
  resolveCmuxBin: () => "/fake/cmux",
}));
vi.mock("node:child_process", () => ({
  execSync: execMock,
  execFileSync: execFileSyncMock,
  // Node-callback shape: util.promisify(execFile) awaits (err, stdout, stderr).
  execFile: execFileMock,
}));

describe("CmuxNotifier", () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
  });

  it("has name 'cmux'", () => {
    expect(createCmuxNotifier({}).name).toBe("cmux");
  });

  it("notify invokes 'squadrant runtime send --command' with the message as one argv element", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, "", ""));
    await createCmuxNotifier({}).notify("hello world");
    expect(execFileMock).toHaveBeenCalledWith(
      "squadrant",
      ["runtime", "send", "--command", "hello world"],
      expect.anything(),
      expect.any(Function),
    );
  });

  // Regression for #120: notification text containing backtick-wrapped or $()
  // commands must reach the spawn as a single literal argv element, never parsed
  // by a shell. Same class as #118/#119.
  it("notify delivers backtick/$() shell metacharacters as a literal argv element, not executed", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, "", ""));
    const malicious = 'done `cmux close-workspace` and $(rm -rf /)';
    await createCmuxNotifier({}).notify(malicious);
    const call = execFileMock.mock.calls[0];
    expect(call[0]).toBe("squadrant");
    const argv = call[1] as string[];
    // The entire message — backticks, $(), and all — is one untouched argv element.
    expect(argv).toEqual(["runtime", "send", "--command", malicious]);
    expect(argv[argv.length - 1]).toBe(malicious);
  });

  it("notify throws when squadrant runtime send fails", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(new Error("send failed")));
    await expect(createCmuxNotifier({}).notify("x")).rejects.toThrow(/send failed/);
  });

  // #579/#484 Gap 1: the daemon calls notify() from inside its own event loop
  // (the DELIVERY STUCK fault alert) — it must never block that loop the way
  // execFileSync would. Proves notify() doesn't return/resolve synchronously.
  it("notify does not block synchronously — resolves only after the async callback fires", async () => {
    let resolved = false;
    let fireCallback!: () => void;
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      fireCallback = () => cb(null, "", "");
    });
    const p = createCmuxNotifier({}).notify("x").then(() => { resolved = true; });
    await Promise.resolve(); // let the notify() call proceed to the execFile mock
    expect(resolved).toBe(false); // still pending — proves no sync execFileSync-style block
    fireCallback();
    await p;
    expect(resolved).toBe(true);
  });

  it("probe returns installed+reachable=true when cmux capabilities succeeds", async () => {
    execFileSyncMock.mockImplementation(() => '{"access_mode":"automation"}');
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(true);
    expect(probe.reachable).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith("/fake/cmux", ["capabilities"], expect.anything());
  });

  it("probe returns reachable=false when cmux capabilities fails (not running)", async () => {
    execFileSyncMock.mockImplementation(() => {
      const err: Error & { status?: number } = new Error("socket not found");
      err.status = 1;
      throw err;
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(true);
    expect(probe.reachable).toBe(false);
  });

  it("probe returns installed=false when the cmux binary is missing", async () => {
    execFileSyncMock.mockImplementation(() => {
      const err: Error & { code?: string } = new Error("spawn /fake/cmux ENOENT");
      err.code = "ENOENT";
      throw err;
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(false);
    expect(probe.reachable).toBe(false);
  });
});
