// src/control/__tests__/launchd.test.ts
import { describe, it, expect } from "vitest";
import { renderPlist, LABEL } from "../launchd.js";

describe("launchd plist", () => {
  it("renders a KeepAlive RunAtLoad plist pointing at the daemon entry", () => {
    const xml = renderPlist("/usr/local/bin/node", "/opt/cockpit/dist/control/cockpitd.js");
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("/opt/cockpit/dist/control/cockpitd.js");
  });

  it("sets ThrottleInterval so a crash can't tight-respawn (red-team #2)", () => {
    const xml = renderPlist("/usr/local/bin/node", "/opt/cockpit/dist/control/cockpitd.js");
    expect(xml).toMatch(/<key>ThrottleInterval<\/key><integer>\d+<\/integer>/);
  });

  it("XML-escapes interpolated values so a special-char home dir stays well-formed", () => {
    const xml = renderPlist("/Users/O&M/bin/node", "/x/<y>/cockpitd.js");
    expect(xml).toContain("/Users/O&amp;M/bin/node");
    expect(xml).toContain("/x/&lt;y&gt;/cockpitd.js");
    // No raw &/< from interpolation should survive inside <string> values.
    expect(xml).not.toContain("/Users/O&M/bin/node");
    expect(xml).not.toContain("/x/<y>/cockpitd.js");
    // The only `&` occurrences are well-formed entities.
    expect(xml.replace(/&(amp|lt|gt|quot);/g, "")).not.toContain("&");
  });
});
