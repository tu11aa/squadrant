import { describe, it, expect, vi } from "vitest";
import {
  ROUTER_READY_ATTEMPTS,
  buildRouterCredentialsRequest,
  resolveRouterCredentials,
} from "../credentials.js";
import type { RouterService } from "../service.js";

function makeService(overrides: Partial<RouterService> = {}): RouterService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    url: vi.fn().mockReturnValue("http://127.0.0.1:1"),
    health: vi.fn().mockResolvedValue({ ready: true, upstreamReachable: true }),
    credentialsFor: vi.fn().mockReturnValue({ backend: "proxy", baseUrl: "http://127.0.0.1:1", token: "t" }),
    ...overrides,
  } as unknown as RouterService;
}

describe("buildRouterCredentialsRequest", () => {
  it("builds the wire request", () => {
    expect(buildRouterCredentialsRequest("proj", "proxy")).toEqual({
      kind: "router-credentials",
      project: "proj",
      backend: "proxy",
    });
  });
});

describe("resolveRouterCredentials", () => {
  it("waits for the shim to become ready, then returns credentials", async () => {
    const health = vi
      .fn()
      .mockResolvedValueOnce({ ready: false, upstreamReachable: true })
      .mockResolvedValue({ ready: true, upstreamReachable: true });
    const svc = makeService({ health: health as unknown as RouterService["health"] });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const creds = await resolveRouterCredentials(svc, "proj", "proxy", { sleep });

    expect(health).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(svc.credentialsFor).toHaveBeenCalledWith("proj", "proxy");
    expect(creds).toEqual({ backend: "proxy", baseUrl: "http://127.0.0.1:1", token: "t" });
  });

  it("does not wait for a direct backend (no shim in the path)", async () => {
    const svc = makeService();
    await resolveRouterCredentials(svc, "proj", "direct", { sleep: vi.fn() });
    expect(svc.health).not.toHaveBeenCalled();
    expect(svc.credentialsFor).toHaveBeenCalledWith("proj", "direct");
  });

  it("gives up after the bounded attempts and lets credentialsFor surface the error", async () => {
    const svc = makeService({
      health: vi.fn().mockResolvedValue({ ready: false, upstreamReachable: true }),
      credentialsFor: vi.fn().mockImplementation(() => {
        throw new Error("router service not started");
      }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(resolveRouterCredentials(svc, "proj", "proxy", { sleep })).rejects.toThrow(
      /not started/,
    );
    expect(sleep).toHaveBeenCalledTimes(ROUTER_READY_ATTEMPTS);
  });
});
