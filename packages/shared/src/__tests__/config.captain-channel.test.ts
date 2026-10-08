import { describe, it, expect } from "vitest";
import { resolveCaptainChannelMode } from "../config.js";

describe("resolveCaptainChannelMode (#667 slice 4)", () => {
  it("is on when unset (#887)", () => {
    expect(resolveCaptainChannelMode(undefined)).toBe("on");
    expect(resolveCaptainChannelMode({} as never)).toBe("on");
  });

  it("accepts the three valid positions", () => {
    expect(resolveCaptainChannelMode({ captainChannel: "off" } as never)).toBe("off");
    expect(resolveCaptainChannelMode({ captainChannel: "shadow" } as never)).toBe("shadow");
    expect(resolveCaptainChannelMode({ captainChannel: "on" } as never)).toBe("on");
  });

  it("treats a typo as the default (on)", () => {
    expect(resolveCaptainChannelMode({ captainChannel: "ON" } as never)).toBe("on");
    expect(resolveCaptainChannelMode({ captainChannel: "enabled" } as never)).toBe("on");
  });

  it("is independent of the per-agent crew flag", () => {
    expect(resolveCaptainChannelMode({ controlChannel: { claude: "off" } } as never)).toBe("on");
  });
});
