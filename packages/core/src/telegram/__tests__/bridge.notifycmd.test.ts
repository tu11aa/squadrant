import { describe, it, expect } from "vitest";
import { parseNotifyPref } from "../bridge.js";

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
});
