import { describe, it, expect } from "vitest";
import { resolveCaptainChannelMode } from "../config.js";

describe("resolveCaptainChannelMode (#667 slice 4)", () => {
  it("is off when unset — a fresh config changes nothing", () => {
    expect(resolveCaptainChannelMode(undefined)).toBe("off");
    expect(resolveCaptainChannelMode({} as never)).toBe("off");
  });

  it("accepts the three valid positions", () => {
    expect(resolveCaptainChannelMode({ captainChannel: "off" } as never)).toBe("off");
    expect(resolveCaptainChannelMode({ captainChannel: "shadow" } as never)).toBe("shadow");
    expect(resolveCaptainChannelMode({ captainChannel: "on" } as never)).toBe("on");
  });

  it("treats a typo as off, never as on", () => {
    // A config typo must never silently take the delivery path with it.
    expect(resolveCaptainChannelMode({ captainChannel: "ON" } as never)).toBe("off");
    expect(resolveCaptainChannelMode({ captainChannel: "enabled" } as never)).toBe("off");
  });

  it("is independent of the per-agent crew flag", () => {
    expect(resolveCaptainChannelMode({ controlChannel: { claude: "on" } } as never)).toBe("off");
  });
});
