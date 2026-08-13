// packages/core/src/__tests__/launchd.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
import { execFileSync } from "node:child_process";
import { renderPlist, LABEL, kickstartArgv, sanitizePathForPlist, programArgsBlock, AGENT_BINS, resolveAgentBinDirs, buildDaemonPath, isOperatorInitiatedCommand, OPERATOR_INITIATED_COMMANDS, parseProgramArgs, detectForeignInstall } from "../launchd.js";

describe("launchd plist", () => {
  it("renders a KeepAlive RunAtLoad plist pointing at the daemon entry", () => {
    const xml = renderPlist("/usr/local/bin/node", "/opt/squadrant/dist/control/squadrantd.js");
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("/opt/squadrant/dist/control/squadrantd.js");
  });

  it("sets ThrottleInterval so a crash can't tight-respawn (red-team #2)", () => {
    const xml = renderPlist("/usr/local/bin/node", "/opt/squadrant/dist/control/squadrantd.js");
    expect(xml).toMatch(/<key>ThrottleInterval<\/key><integer>\d+<\/integer>/);
  });

  it("bakes PATH into EnvironmentVariables so launchd headless spawn resolves (red-team #3)", () => {
    const p = "/Users/me/.nvm/versions/node/v24/bin:/Applications/cmux.app/Contents/Resources/bin:/usr/bin";
    const xml = renderPlist("/usr/local/bin/node", "/opt/squadrant/dist/control/squadrantd.js", p);
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain(`<key>PATH</key><string>${p}</string>`);
  });

  it("XML-escapes a PATH containing special chars", () => {
    const xml = renderPlist("/n", "/d/squadrantd.js", "/a&b:/c<d>");
    expect(xml).toContain("<string>/a&amp;b:/c&lt;d&gt;</string>");
    expect(xml).not.toContain("/a&b:/c<d>");
  });

  // Follow-up bug: ensureDaemon ran on EVERY squadrant invocation and
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
    const xml = renderPlist("/Users/O&M/bin/node", "/x/<y>/squadrantd.js");
    expect(xml).toContain("/Users/O&amp;M/bin/node");
    expect(xml).toContain("/x/&lt;y&gt;/squadrantd.js");
    // No raw &/< from interpolation should survive inside <string> values.
    expect(xml).not.toContain("/Users/O&M/bin/node");
    expect(xml).not.toContain("/x/<y>/squadrantd.js");
    // The only `&` occurrences are well-formed entities.
    expect(xml.replace(/&(amp|lt|gt|quot);/g, "")).not.toContain("&");
  });

  // programArgsBlock: used by ensureDaemon to detect semantic drift (PATH vs
  // program-args changes). Only program-arg changes warrant a full restart.
  it("programArgsBlock renders an XML array with both escaped entries", () => {
    expect(programArgsBlock("/usr/local/bin/node", "/opt/squadrant/dist/control/squadrantd.js")).toBe(
      "<array><string>/usr/local/bin/node</string><string>/opt/squadrant/dist/control/squadrantd.js</string></array>"
    );
  });

  it("programArgsBlock escapes special chars like renderPlist does", () => {
    expect(programArgsBlock("/u&s/r/bin/<node>", "/x/y/z.js")).toBe(
      "<array><string>/u&amp;s/r/bin/&lt;node&gt;</string><string>/x/y/z.js</string></array>"
    );
  });

  it("programArgsBlock matches the actual array emitted by renderPlist", () => {
    const xml = renderPlist("/nvm/v24/bin/node", "/dist/squadrantd.js");
    expect(xml).toContain(programArgsBlock("/nvm/v24/bin/node", "/dist/squadrantd.js"));
  });
});

// #636: cold-start / post-upgrade escape hatch — a human explicitly typing
// `squadrant launch` or `squadrant init` is authorized the same as a captain
// marker, even with no SQUADRANT_ROLE set. Everything else stays unauthorized.
describe("isOperatorInitiatedCommand (#636)", () => {
  it("authorizes 'launch' and 'init'", () => {
    expect(isOperatorInitiatedCommand("launch")).toBe(true);
    expect(isOperatorInitiatedCommand("init")).toBe(true);
  });

  it("does NOT authorize 'heal' — heal daemon bypasses this gate entirely via reregisterDaemon", () => {
    expect(isOperatorInitiatedCommand("heal")).toBe(false);
  });

  it("does NOT authorize crew, status, or any other subcommand", () => {
    expect(isOperatorInitiatedCommand("crew")).toBe(false);
    expect(isOperatorInitiatedCommand("status")).toBe(false);
    expect(isOperatorInitiatedCommand("dashboard")).toBe(false);
  });

  it("does NOT authorize a missing/undefined argv[2] (bare `squadrant` invocation)", () => {
    expect(isOperatorInitiatedCommand(undefined)).toBe(false);
  });

  it("OPERATOR_INITIATED_COMMANDS is exactly {launch, init} — deliberately small", () => {
    expect([...OPERATOR_INITIATED_COMMANDS].sort()).toEqual(["init", "launch"]);
  });
});

// #670: ensureDaemon must never seize a plist that belongs to a DIFFERENT
// squadrant install (e.g. a rival npm-global copy). parseProgramArgs reads
// what's currently registered; detectForeignInstall decides whether it's
// safe to overwrite.
describe("parseProgramArgs", () => {
  it("round-trips the nodeBin and daemonEntry rendered by renderPlist", () => {
    const xml = renderPlist("/usr/local/bin/node", "/opt/squadrant/dist/squadrantd.js");
    expect(parseProgramArgs(xml)).toEqual({
      nodeBin: "/usr/local/bin/node",
      daemonEntry: "/opt/squadrant/dist/squadrantd.js",
    });
  });

  it("XML-unescapes special characters", () => {
    const xml = renderPlist("/Users/O&M/bin/node", "/x/<y>/squadrantd.js");
    expect(parseProgramArgs(xml)).toEqual({
      nodeBin: "/Users/O&M/bin/node",
      daemonEntry: "/x/<y>/squadrantd.js",
    });
  });

  it("returns null when ProgramArguments is missing", () => {
    expect(parseProgramArgs("<plist><dict></dict></plist>")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseProgramArgs("not xml at all")).toBeNull();
  });
});

describe("detectForeignInstall (#670)", () => {
  const thisEntry = "/Users/me/Library/pnpm/global/5/.pnpm/squadrant@0.18.0/dist/squadrantd.js";
  const rivalEntry = "/Users/me/.nvm/versions/node/v24.6.0/lib/node_modules/squadrant/dist/squadrantd.js";

  it("returns null when there is nothing currently registered (parsed=null)", () => {
    expect(detectForeignInstall(null, thisEntry, true)).toBeNull();
  });

  it("returns null when the registered entry IS this install (no conflict)", () => {
    expect(detectForeignInstall({ nodeBin: "/n", daemonEntry: thisEntry }, thisEntry, true)).toBeNull();
  });

  it("returns null when the registered entry differs but no longer exists on disk (stale — safe to reclaim)", () => {
    expect(detectForeignInstall({ nodeBin: "/n", daemonEntry: rivalEntry }, thisEntry, false)).toBeNull();
  });

  it("flags a foreign install when the registered entry differs AND still exists on disk", () => {
    const result = detectForeignInstall({ nodeBin: "/n", daemonEntry: rivalEntry }, thisEntry, true);
    expect(result).toEqual({ registeredEntry: rivalEntry, thisEntry });
  });
});

describe("resolveAgentBinDirs", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("resolves available agent binaries and returns their dirnames", () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      if (cmd === "which" && args?.[0] === "cmux") return "/Applications/cmux.app/Contents/Resources/bin/cmux\n";
      if (cmd === "which" && args?.[0] === "claude") return "/Users/me/.npm-global/bin/claude\n";
      if (cmd === "which" && args?.[0] === "opencode") return "/Users/me/.npm-global/bin/opencode\n";
      throw new Error("not found");
    });
    const dirs = resolveAgentBinDirs();
    expect(dirs).toContain("/Applications/cmux.app/Contents/Resources/bin");
    expect(dirs).toContain("/Users/me/.npm-global/bin");
    // codex, gemini, node — not found, skipped
    expect(dirs.length).toBe(2);
  });

  it("skips missing binaries without error", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not found"); });
    expect(resolveAgentBinDirs()).toEqual([]);
  });

  it("dedupes when multiple binaries resolve to the same directory", () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      if (args?.[0] === "node" || args?.[0] === "opencode") return "/Users/me/.npm-global/bin/node\n";
      throw new Error("not found");
    });
    const dirs = resolveAgentBinDirs();
    expect(dirs).toEqual(["/Users/me/.npm-global/bin"]);
  });
});

describe("buildDaemonPath", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("prepends agent bin dirs to sanitized path", () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      if (cmd === "which" && args?.[0] === "claude") return "/opt/homebrew/bin/claude\n";
      if (cmd === "which" && args?.[0] === "node") return "/Users/me/.nvm/versions/node/v24/bin/node\n";
      throw new Error("not found");
    });
    const result = buildDaemonPath("/usr/bin:/bin");
    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/Users/me/.nvm/versions/node/v24/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
    expect(result.startsWith("/opt/homebrew/bin")).toBe(true);
  });

  it("still strips plugin-cache directories from shell PATH", () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      if (cmd === "which" && args?.[0] === "node") return "/usr/local/bin/node\n";
      throw new Error("not found");
    });
    const result = buildDaemonPath("/usr/bin:/Users/me/.claude/plugins/cache/foo/bin:/bin");
    expect(result).not.toContain(".claude/plugins");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("returns sanitized path unchanged when no agent binaries found", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not found"); });
    expect(buildDaemonPath("/usr/bin:/bin")).toBe("/usr/bin:/bin");
  });

  it("output is deterministic (stable order, deduped)", () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      if (cmd === "which" && args?.[0] === "cmux") return "/opt/bin/cmux\n";
      if (cmd === "which" && args?.[0] === "node") return "/usr/local/bin/node\n";
      throw new Error("not found");
    });
    const a = buildDaemonPath("/usr/bin:/opt/bin:/bin");
    const b = buildDaemonPath("/usr/bin:/opt/bin:/bin");
    expect(a).toBe(b);
    // /opt/bin from shell PATH is deduped against the cmux agent dir
    expect(a).toBe("/opt/bin:/usr/local/bin:/usr/bin:/bin");
  });
});
