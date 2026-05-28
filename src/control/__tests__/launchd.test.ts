// src/control/__tests__/launchd.test.ts
import { describe, it, expect } from "vitest";
import { renderPlist, LABEL, kickstartArgv, sanitizePathForPlist, programArgsBlock } from "../launchd.js";

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

  it("bakes PATH into EnvironmentVariables so launchd headless spawn resolves (red-team #3)", () => {
    const p = "/Users/me/.nvm/versions/node/v24/bin:/Applications/cmux.app/Contents/Resources/bin:/usr/bin";
    const xml = renderPlist("/usr/local/bin/node", "/opt/cockpit/dist/control/cockpitd.js", p);
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain(`<key>PATH</key><string>${p}</string>`);
  });

  it("XML-escapes a PATH containing special chars", () => {
    const xml = renderPlist("/n", "/d/cockpitd.js", "/a&b:/c<d>");
    expect(xml).toContain("<string>/a&amp;b:/c&lt;d&gt;</string>");
    expect(xml).not.toContain("/a&b:/c<d>");
  });

  // Follow-up bug: ensureDaemon ran on EVERY cockpit invocation and
  // `kickstart -k` killed+restarted a healthy daemon each time (orphaning
  // in-flight headless crew). -k must be used ONLY when the plist changed.
  it("kickstartArgv: no -k when plist unchanged (don't bounce a healthy daemon)", () => {
    const t = `gui/501/${LABEL}`;
    expect(kickstartArgv(t, false)).toEqual(["kickstart", t]);
    expect(kickstartArgv(t, false)).not.toContain("-k");
  });

  it("kickstartArgv: -k only when plist changed (force reload of new config)", () => {
    const t = `gui/501/${LABEL}`;
    expect(kickstartArgv(t, true)).toEqual(["kickstart", "-k", t]);
  });

  // Hotfix 2026-05-21: ensureDaemon was killing the running daemon on every
  // CLI invocation because Claude Code shells inject ~/.claude/plugins/cache/*
  // bin dirs into PATH, making renderPlist's output differ from a fresh shell's
  // → plistChanged=true → kickstart -k. The fix strips those ephemeral entries
  // before baking PATH into the plist.
  it("sanitizePathForPlist: produces identical output across captain vs fresh shells", () => {
    const fresh = "/Users/me/.nvm/versions/node/v24/bin:/usr/local/bin:/usr/bin";
    const captain =
      "/Users/me/.claude/plugins/cache/foo/bin:/Users/me/.nvm/versions/node/v24/bin:/Users/me/.claude/plugins/cache/bar/bin:/usr/local/bin:/usr/bin";
    expect(sanitizePathForPlist(captain)).toBe(sanitizePathForPlist(fresh));
  });

  it("sanitizePathForPlist: dedupes while preserving first-occurrence order", () => {
    expect(sanitizePathForPlist("/a:/b:/a:/c::/b")).toBe("/a:/b:/c");
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

  // programArgsBlock: used by ensureDaemon to detect semantic drift (PATH vs
  // program-args changes). Only program-arg changes warrant a full restart.
  it("programArgsBlock renders an XML array with both escaped entries", () => {
    expect(programArgsBlock("/usr/local/bin/node", "/opt/cockpit/dist/control/cockpitd.js")).toBe(
      "<array><string>/usr/local/bin/node</string><string>/opt/cockpit/dist/control/cockpitd.js</string></array>"
    );
  });

  it("programArgsBlock escapes special chars like renderPlist does", () => {
    expect(programArgsBlock("/u&s/r/bin/<node>", "/x/y/z.js")).toBe(
      "<array><string>/u&amp;s/r/bin/&lt;node&gt;</string><string>/x/y/z.js</string></array>"
    );
  });

  it("programArgsBlock matches the actual array emitted by renderPlist", () => {
    const xml = renderPlist("/nvm/v24/bin/node", "/dist/cockpitd.js");
    expect(xml).toContain(programArgsBlock("/nvm/v24/bin/node", "/dist/cockpitd.js"));
  });
});
