import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCaptainAddress } from "@squadrant/core";
import { resolveCaptainAgent } from "../captain-channel-factory.js";

describe("resolveCaptainAgent (#786)", () => {
  const root = () => mkdtempSync(join(tmpdir(), "cap-agent-"));

  it("prefers the launch record over config", () => {
    const r = root();
    writeCaptainAddress(r, "demo", { agent: "opencode", port: 1, directory: "/p", launchedAt: "x" });
    expect(resolveCaptainAgent(r, "demo", "claude")).toBe("opencode");
  });

  it("falls back to config when there is no record", () => {
    expect(resolveCaptainAgent(root(), "demo", "opencode")).toBe("opencode");
    expect(resolveCaptainAgent(root(), "demo", undefined)).toBeUndefined();
  });
});
