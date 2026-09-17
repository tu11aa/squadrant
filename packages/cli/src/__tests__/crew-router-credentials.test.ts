import { describe, it, expect, vi } from "vitest";
import { fetchRouterCredentials } from "../commands/crew.js";

describe("fetchRouterCredentials", () => {
  it("requests credentials over the daemon socket", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "proxy",
      baseUrl: "http://127.0.0.1:1",
      token: "tok",
    });
    const creds = await fetchRouterCredentials("proj", "proxy", { call });
    expect(call).toHaveBeenCalledWith({
      kind: "router-credentials",
      project: "proj",
      backend: "proxy",
    });
    expect(creds).toEqual({ backend: "proxy", baseUrl: "http://127.0.0.1:1", token: "tok" });
  });

  it("pre-approves the key for a direct backend", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "direct",
      baseUrl: "https://opencode.ai/zen/go",
      apiKey: "sk-live",
    });
    const approveKey = vi.fn().mockReturnValue({ changed: true });
    const log = vi.fn();
    await fetchRouterCredentials("proj", "direct", { call, approveKey, log });
    expect(approveKey).toHaveBeenCalledWith("sk-live", expect.objectContaining({ log }));
  });

  it("logs why pre-approval was skipped instead of failing silently", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "direct",
      baseUrl: "https://x",
      apiKey: "sk-live",
    });
    const approveKey = vi.fn().mockReturnValue({ changed: false, reason: "no ~/.claude.json yet" });
    const log = vi.fn();
    await fetchRouterCredentials("proj", "direct", { call, approveKey, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no ~/.claude.json yet"));
  });

  it("does not pre-approve for a proxy backend (no real key in the env)", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "proxy",
      baseUrl: "http://127.0.0.1:1",
      token: "tok",
    });
    const approveKey = vi.fn();
    await fetchRouterCredentials("proj", "proxy", { call, approveKey });
    expect(approveKey).not.toHaveBeenCalled();
  });
});
