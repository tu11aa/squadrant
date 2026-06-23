import { describe, it, expect } from "vitest";
import { parseNotifyPref, notifyToggle } from "../bridge.js";

describe("parseNotifyPref", () => {
  it("parses /notify crew all", () => {
    expect(parseNotifyPref("/notify crew all")).toEqual({ dimension: "crew", value: "all" });
  });
  it("parses /notify cap off", () => {
    expect(parseNotifyPref("/notify cap off")).toEqual({ dimension: "cap", value: "off" });
  });
  it("returns null for ordinary text", () => {
    expect(parseNotifyPref("please ship it")).toBeNull();
  });
  it("returns null for /notify with no dimension", () => {
    expect(parseNotifyPref("/notify")).toBeNull();
  });

  // @botname suffix — Telegram appends this when tapped from / menu in groups
  it("strips @botname from /notify@squadrant_bot cap on", () => {
    expect(parseNotifyPref("/notify@squadrant_bot cap on")).toEqual({ dimension: "cap", value: "on" });
  });

  it("strips @botname from /notify@squadrant_bot crew all", () => {
    expect(parseNotifyPref("/notify@squadrant_bot crew all")).toEqual({ dimension: "crew", value: "all" });
  });
});

describe("notifyToggle", () => {
  it("/unmute returns true", () => { expect(notifyToggle("/unmute")).toBe(true); });
  it("/mute returns false", () => { expect(notifyToggle("/mute")).toBe(false); });
  it("ordinary text returns null", () => { expect(notifyToggle("hello")).toBeNull(); });

  // @botname suffix — tapped from / menu in groups
  it("/unmute@squadrant_bot returns true", () => { expect(notifyToggle("/unmute@squadrant_bot")).toBe(true); });
  it("/mute@squadrant_bot returns false", () => { expect(notifyToggle("/mute@squadrant_bot")).toBe(false); });
});
