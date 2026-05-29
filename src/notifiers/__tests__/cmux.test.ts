import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCmuxNotifier } from "../cmux.js";

const execMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execSync: execMock,
  execFileSync: execFileMock,
}));

describe("CmuxNotifier", () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
  });

  it("has name 'cmux'", () => {
    expect(createCmuxNotifier({}).name).toBe("cmux");
  });

  it("notify invokes 'cockpit runtime send --command' with the message as one argv element", async () => {
    execFileMock.mockReturnValue("");
    await createCmuxNotifier({}).notify("hello world");
    expect(execFileMock).toHaveBeenCalledWith(
      "cockpit",
      ["runtime", "send", "--command", "hello world"],
      expect.anything(),
    );
  });

  // Regression for #120: notification text containing backtick-wrapped or $()
  // commands must reach the spawn as a single literal argv element, never parsed
  // by a shell. Same class as #118/#119.
  it("notify delivers backtick/$() shell metacharacters as a literal argv element, not executed", async () => {
    execFileMock.mockReturnValue("");
    const malicious = 'done `cmux close-workspace` and $(rm -rf /)';
    await createCmuxNotifier({}).notify(malicious);
    const call = execFileMock.mock.calls[0];
    expect(call[0]).toBe("cockpit");
    const argv = call[1] as string[];
    // The entire message — backticks, $(), and all — is one untouched argv element.
    expect(argv).toEqual(["runtime", "send", "--command", malicious]);
    expect(argv[argv.length - 1]).toBe(malicious);
  });

  it("notify throws when cockpit runtime send fails", async () => {
    execFileMock.mockImplementation(() => { throw new Error("send failed"); });
    await expect(createCmuxNotifier({}).notify("x")).rejects.toThrow(/send failed/);
  });

  it("probe returns installed+reachable=true when status succeeds (exit 0)", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("cockpit runtime status --command")) return "running";
      return "";
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(true);
    expect(probe.reachable).toBe(true);
  });

  it("probe returns reachable=false when status throws (non-zero exit)", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("cockpit runtime status --command")) {
        const err: Error & { status?: number } = new Error("stopped");
        err.status = 1;
        throw err;
      }
      return "";
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(true);
    expect(probe.reachable).toBe(false);
  });

  it("probe returns installed=false when cockpit binary is missing", async () => {
    execMock.mockImplementation(() => {
      const err: Error & { code?: string } = new Error("cockpit: command not found");
      err.code = "ENOENT";
      throw err;
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(false);
    expect(probe.reachable).toBe(false);
  });
});
