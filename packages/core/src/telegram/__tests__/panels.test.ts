import { describe, it, expect } from "vitest";
import { notifyPanel, effortPanel, projectPicker, parseCallback } from "../panels.js";

describe("notifyPanel", () => {
  it("offers the opposite cap state and marks the current crew tier", () => {
    const kb = notifyPanel({ active: true, cap: true, crew: "alert_only" });
    const flat = kb.inline_keyboard.flat();
    // cap is ON → the button toggles it OFF
    expect(flat.find((b) => b.callback_data === "n:cap:off")).toBeTruthy();
    const crewBtn = flat.find((b) => b.callback_data === "n:crew:alert_only")!;
    expect(crewBtn.text).toMatch(/[•✓]/); // current tier marked
  });

  it("offers cap ON when cap is currently off", () => {
    const kb = notifyPanel({ active: false, cap: false, crew: "none" });
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.callback_data === "n:cap:on")).toBeTruthy();
    // muted → the active button offers turning notifications ON
    expect(flat.find((b) => b.callback_data === "n:active:on")).toBeTruthy();
  });
});

describe("effortPanel", () => {
  it("marks the current mode", () => {
    const kb = effortPanel("balance");
    const b = kb.inline_keyboard.flat().find((x) => x.callback_data === "e:balance")!;
    expect(b.text).toMatch(/[•✓]/);
    const other = kb.inline_keyboard.flat().find((x) => x.callback_data === "e:max")!;
    expect(other.text).not.toMatch(/[•✓]/);
  });
});

describe("projectPicker", () => {
  it("emits one button per project with the action prefix", () => {
    const kb = projectPicker("cr", ["brove", "solder"]);
    expect(kb.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["cr:brove", "cr:solder"]);
  });
});

describe("parseCallback", () => {
  it("round-trips each kind", () => {
    expect(parseCallback("n:crew:none")).toEqual({ t: "notify", dim: "crew", val: "none" });
    expect(parseCallback("n:cap:on")).toEqual({ t: "notify", dim: "cap", val: "on" });
    expect(parseCallback("n:active:off")).toEqual({ t: "notify", dim: "active", val: "off" });
    expect(parseCallback("e:max")).toEqual({ t: "effort", mode: "max" });
    expect(parseCallback("cr:brove")).toEqual({ t: "pick", action: "cr", project: "brove" });
    expect(parseCallback("lc:solder")).toEqual({ t: "pick", action: "lc", project: "solder" });
    expect(parseCallback("garbage")).toBeNull();
    expect(parseCallback("n:bogus:x")).toBeNull();
  });
});
