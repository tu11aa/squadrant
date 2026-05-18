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
});
