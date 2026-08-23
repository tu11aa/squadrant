// Tests for the #667 controlChannel rollout flag.
import { describe, it, expect } from "vitest";
import { resolveControlChannelMode } from "../config.js";

describe("resolveControlChannelMode", () => {
  it("an absent controlChannel block means off for every agent", () => {
    // Safe by default: merging slice 2 must change nothing for anyone who has
    // not opted in.
    expect(resolveControlChannelMode(undefined, "opencode")).toBe("off");
  });

  it("an agent not listed defaults to off", () => {
    expect(resolveControlChannelMode({ claude: "on" }, "opencode")).toBe("off");
  });

  it("returns the configured mode for a listed agent", () => {
    expect(resolveControlChannelMode({ opencode: "shadow" }, "opencode")).toBe("shadow");
    expect(resolveControlChannelMode({ opencode: "on" }, "opencode")).toBe("on");
  });

  it("an invalid value falls back to off rather than throwing", () => {
    // A typo in config must not take the delivery path with it.
    expect(resolveControlChannelMode({ opencode: "yes" as never }, "opencode")).toBe("off");
  });

  it("agents are independent — claude on does not enable opencode", () => {
    const cfg = { claude: "on" as const, opencode: "off" as const };
    expect(resolveControlChannelMode(cfg, "claude")).toBe("on");
    expect(resolveControlChannelMode(cfg, "opencode")).toBe("off");
  });
});