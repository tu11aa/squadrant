import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCmuxDriver, sanitizeForCmuxSend, parseDraftFromScreen, DeferDelivery } from "../cmux.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFileSync: execFileMock,
}));

// cmux() now invokes execFileSync(CMUX_BIN, argv[], opts) with no shell, so the
// command + its arguments arrive as an argv array (calls[i][1]). These helpers
// surface the argv for assertions; the binary path itself (calls[i][0]) is
// irrelevant to behavior.
const argvOf = (call: unknown[]): string[] => call[1] as string[];
const cmdOf = (call: unknown[]): string => (call[1] as string[]).join(" ");

// Build a minimal screen in the real Claude Code format for parseDraftFromScreen tests.
// Layout: optional transcript lines, then top-HR, then inputLine, then bottom-HR, then
// a two-line status block. The HR lines use U+2500 ─ (110 chars) matching a real screen.
const HR = "─".repeat(110);
function makeTestScreen(inputLine: string, ...transcriptLines: string[]): string {
  return [
    ...transcriptLines,
    HR,
    inputLine,
    HR,
    "   Model: Opus 4.8  Ctx Used: 52.0%",
    "  ⏵⏵ auto mode on",
  ].join("\n");
}

describe("cmux driver", () => {
  const driver = createCmuxDriver();

  beforeEach(() => {
    execFileMock.mockReset();
  });

  describe("subprocess timeout", () => {
    // Retrieve the 3rd argument (options) from an execFileSync mock call
    const optsOf = (call: unknown[]) => call[2] as Record<string, unknown>;

    it("passes a positive timeout to execFileSync", async () => {
      execFileMock.mockReturnValue("");
      await driver.probe();
      // resolveCmuxBin's `which` call is first; the cmux call has --version.
      const cmuxCall = execFileMock.mock.calls.find((c: unknown[]) =>
        (c[1] as string[]).includes("--version"),
      );
      expect(cmuxCall).toBeDefined();
      expect(((cmuxCall as unknown[])[2] as Record<string, unknown>).timeout).toBeGreaterThan(0);
    });

    it("throws a clean CmuxTimeoutError when execFileSync times out (unwrapped caller)", async () => {
      execFileMock.mockImplementation(() => {
        const err = new Error("cmux hung");
        (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
        throw err;
      });
      // sendKey doesn't wrap cmux() in try/catch — the typed error
      // should propagate as-is with no ETIMEDOUT/stack leak.
      await expect(driver.sendKey("workspace:1", "Enter"))
        .rejects.toThrow(/cmux timeout/i);
    });
  });

  it("has name 'cmux'", () => {
    expect(driver.name).toBe("cmux");
  });

  it("probe returns installed=true with version when cmux responds", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("--version")) return "cmux 0.12.3\n";
      return "";
    });
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("cmux 0.12.3");
  });

  it("probe returns installed=false when cmux throws", async () => {
    execFileMock.mockImplementation(() => { throw new Error("not found"); });
    const result = await driver.probe();
    expect(result.installed).toBe(false);
    expect(result.version).toBe("");
  });

  it("list parses list-workspaces output into WorkspaceRefs", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list-workspaces")) {
        return [
          "workspace:1  🏛️ command  (running)",
          "workspace:2  brove-captain  [selected]",
          "workspace:3  ⚡ reactor  (running)",
        ].join("\n");
      }
      return "";
    });
    const refs = await driver.list();
    expect(refs).toHaveLength(3);
    expect(refs[1]).toEqual({ id: "workspace:2", name: "brove-captain", status: "running" });
  });

  it("status returns null when name not in list", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list-workspaces")) return "workspace:1  other-ws  (running)";
      return "";
    });
    const ref = await driver.status("brove-captain");
    expect(ref).toBeNull();
  });

  it("status returns WorkspaceRef when name matches", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list-workspaces")) return "workspace:5  brove-captain  (running)";
      return "";
    });
    const ref = await driver.status("brove-captain");
    expect(ref).toEqual({ id: "workspace:5", name: "brove-captain", status: "running" });
  });

  it("send calls cmux send THEN cmux send-key Enter", async () => {
    execFileMock.mockReturnValue("");
    await driver.send("workspace:2", "hello world");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("send") && c.includes("hello world") && !c.includes("send-key"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("Enter"))).toBe(true);
  });

  it("send routes to surface named after workspace when one exists", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("list-workspaces")) return "workspace:2  test-ws  (running)";
      if (cmd.includes("tree"))           return '  └── surface surface:5 [terminal] "test-ws"';
      return "";
    });
    await driver.send("workspace:2", "hello tab");
    const cmds = execFileMock.mock.calls.map(cmdOf).filter((c) => !c.includes("list-workspaces") && !c.includes("tree"));
    expect(cmds.some((c) => c.includes("send ") && c.includes("--surface surface:5") && c.includes("hello tab") && !c.includes("send-key"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("--surface surface:5") && c.includes("Enter"))).toBe(true);
  });

  it("send falls back to workspace-level when no surface matches workspace name", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("list-workspaces")) return "workspace:2  test-ws  (running)";
      if (cmd.includes("tree"))           return '  └── surface surface:5 [terminal] "crew-1"';
      return "";
    });
    await driver.send("workspace:2", "fallback message");
    const cmds = execFileMock.mock.calls.map(cmdOf).filter((c) => !c.includes("list-workspaces") && !c.includes("tree"));
    expect(cmds.some((c) => c.includes("send ") && !c.includes("--surface") && c.includes("fallback message"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("Enter") && !c.includes("--surface"))).toBe(true);
  });

  it("send passes message text as a single literal argv element (no shell escaping)", async () => {
    execFileMock.mockReturnValue("");
    await driver.send("workspace:2", 'say "hi"');
    const sendCall = execFileMock.mock.calls.find((c) => argvOf(c)[0] === "send");
    expect(sendCall).toBeDefined();
    expect(argvOf(sendCall!)).toContain('say "hi"');
  });

  it("sendKey sends literal key without Enter", async () => {
    execFileMock.mockReturnValue("");
    await driver.sendKey("workspace:2", "Escape");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("send-key");
    expect(cmds[0]).toContain("Escape");
  });

  it("stop calls close-workspace", async () => {
    execFileMock.mockReturnValue("");
    await driver.stop("workspace:2");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds[0]).toContain("close-workspace");
    expect(cmds[0]).toContain("workspace:2");
  });

  it("readScreen calls read-screen and returns output", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return "screen contents\n";
      return "";
    });
    const out = await driver.readScreen("workspace:2");
    expect(out).toBe("screen contents");
  });

  it("spawn creates workspace, renames it, pins it, renames and pins its initial tab", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("new-workspace")) return "Created workspace:7\n";
      if (cmd.includes("tree"))        return '  └── surface surface:1 [terminal] ""';
      return "";
    });
    const ref = await driver.spawn({ name: "test-ws", workdir: "/tmp", command: "echo hi", pinToTop: true });
    expect(ref.id).toBe("workspace:7");
    expect(ref.name).toBe("test-ws");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-workspace"))).toBe(true);
    expect(cmds.some((c) => c.includes("rename-workspace") && c.includes("test-ws"))).toBe(true);
    expect(cmds.some((c) => c.includes("rename-tab") && c.includes("surface:1") && c.includes("test-ws"))).toBe(true);
    expect(cmds.some((c) => c.includes("workspace-action") && c.includes("--action pin"))).toBe(true);
    expect(cmds.some((c) => c.includes("tab-action") && c.includes("--surface surface:1") && c.includes("--action pin"))).toBe(true);
  });

  it("newPane calls cmux new-pane with direction and workspace, parses surface id", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-pane")) return "OK surface:27 pane:25 workspace:1";
      return "";
    });
    const pane = await driver.newPane({ workspaceId: "workspace:1", direction: "right" });
    expect(pane).toEqual({ workspaceId: "workspace:1", surfaceId: "surface:27" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-pane") && c.includes("--direction right") && c.includes("--workspace workspace:1"))).toBe(true);
  });

  it("newPane with direction=tab calls cmux new-surface instead of new-pane", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-surface")) return "OK surface:31 workspace:1";
      return "";
    });
    const pane = await driver.newPane({ workspaceId: "workspace:1", direction: "tab" });
    expect(pane).toEqual({ workspaceId: "workspace:1", surfaceId: "surface:31" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-surface") && c.includes("--workspace workspace:1"))).toBe(true);
    expect(cmds.every((c) => !c.includes("new-pane"))).toBe(true);
    expect(cmds.every((c) => !c.includes("--direction"))).toBe(true);
  });

  // #295: new tab steals cmux focus, leaking user keystrokes into crew launch command.
  // Fix: snapshot selected surface before new-surface, restore focus after creation.
  it("newPane with direction=tab restores focus to the previously-selected surface (#295)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("tree")) {
        return [
          'surface surface:5 [terminal] "captain" [selected]',
          'surface surface:6 [terminal] "crew-1"',
        ].join("\n");
      }
      if (cmd.includes("new-surface")) return "OK surface:8 workspace:1";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:1", direction: "tab" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) =>
      c.includes("move-surface") &&
      c.includes("--surface surface:5") &&
      c.includes("--index 0") &&
      c.includes("--focus true"))).toBe(true);
  });

  it("newPane with direction=tab skips focus restore gracefully when tree is unreadable (#295)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("tree")) throw new Error("tree unreadable");
      if (cmd.includes("new-surface")) return "OK surface:8 workspace:1";
      return "";
    });
    const pane = await driver.newPane({ workspaceId: "workspace:1", direction: "tab" });
    expect(pane.surfaceId).toBe("surface:8");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.every((c) => !c.includes("move-surface"))).toBe(true);
  });

  it("newPane with split direction does NOT query tree or restore focus (#295)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-pane")) return "OK surface:27 pane:25 workspace:1";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:1", direction: "right" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.every((c) => !c.includes("tree"))).toBe(true);
    expect(cmds.every((c) => !c.includes("move-surface"))).toBe(true);
  });

  it("newPane with direction=tab and title renames the new surface", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-surface")) return "OK surface:42 workspace:7";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:7", direction: "tab", title: "🔧 brove-crew" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("rename-tab") && c.includes("--surface surface:42") && c.includes("🔧 brove-crew"))).toBe(true);
  });

  it("newPane with direction=tab throws when output has no surface id", async () => {
    execFileMock.mockReturnValue("garbage");
    await expect(driver.newPane({ workspaceId: "workspace:1", direction: "tab" }))
      .rejects.toThrow(/new-surface did not return a surface/);
  });

  it("newPane with title also calls rename-tab on the new surface", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-pane")) return "OK surface:9 pane:3 workspace:2";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:2", direction: "down", title: "🔧 fix-bug" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("rename-tab") && c.includes("--surface surface:9") && c.includes("🔧 fix-bug"))).toBe(true);
  });

  it("newPane throws when cmux output has no surface id", async () => {
    execFileMock.mockReturnValue("garbage output");
    await expect(driver.newPane({ workspaceId: "workspace:1", direction: "right" }))
      .rejects.toThrow(/did not return a surface/);
  });

  it("closePane calls cmux close-surface with workspace + surface", async () => {
    execFileMock.mockReturnValue("");
    await driver.closePane({ workspaceId: "workspace:1", surfaceId: "surface:9" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("close-surface") && c.includes("--surface surface:9") && c.includes("--workspace workspace:1"))).toBe(true);
  });

  it("closePane swallows errors (already closed is fine)", async () => {
    execFileMock.mockImplementation(() => { throw new Error("not found"); });
    await expect(driver.closePane({ workspaceId: "workspace:1", surfaceId: "surface:9" }))
      .resolves.toBeUndefined();
  });

  it("sendToPane calls cmux send + send-key Enter scoped to surface", async () => {
    execFileMock.mockReturnValue("");
    await driver.sendToPane({ workspaceId: "workspace:1", surfaceId: "surface:9" }, "hello crew");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("send ") && c.includes("--surface surface:9") && c.includes("hello crew") && !c.includes("send-key"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("--surface surface:9") && c.includes("Enter"))).toBe(true);
  });

  // Regression for #136: multi-line message must be sanitized before cmux send
  // so newline bytes don't trigger premature Enter submissions.
  it("sendToPane sanitizes multi-line messages", async () => {
    execFileMock.mockReturnValue("");
    await driver.sendToPane({ workspaceId: "workspace:1", surfaceId: "surface:9" }, "line one\nline two\nline three");
    const sendCall = execFileMock.mock.calls.find((c) => argvOf(c)[0] === "send");
    expect(sendCall).toBeDefined();
    expect(argvOf(sendCall!)).toContain("line one line two line three");
    expect(argvOf(sendCall!)).not.toContain("\n");
  });

  it("send sanitizes multi-line messages", async () => {
    execFileMock.mockReturnValue("");
    await driver.send("workspace:2", "hello\nworld\\nfoo");
    const sendCall = execFileMock.mock.calls.find((c) => argvOf(c)[0] === "send");
    expect(sendCall).toBeDefined();
    expect(argvOf(sendCall!)).toContain("hello world foo");
    expect(argvOf(sendCall!)).not.toContain("\n");
  });

  it("sendToSurface sanitizes multi-line messages", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("\u276F \u258C");
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "multi\nline\r\ntext");
    const sendCall = execFileMock.mock.calls.find((c) => argvOf(c)[0] === "send");
    expect(sendCall).toBeDefined();
    expect(argvOf(sendCall!)).toContain("multi line text");
    // No real newlines in argv
    expect(argvOf(sendCall!).every((s: string) => !s.includes("\n") && !s.includes("\r"))).toBe(true);
  });

  // Regression for #118: a crew prompt containing a backtick-wrapped destructive
  // command must reach cmux as ONE literal argv element, never parsed by a shell.
  it("sendToPane delivers backtick/$ shell metacharacters as literal text, not executed", async () => {
    execFileMock.mockReturnValue("");
    const malicious = 'fix the bug, run `cmux close-workspace` and $(rm -rf /) to verify';
    await driver.sendToPane({ workspaceId: "workspace:1", surfaceId: "surface:9" }, malicious);
    const sendCall = execFileMock.mock.calls.find((c) => argvOf(c)[0] === "send");
    expect(sendCall).toBeDefined();
    // The entire message — backticks, $(), and all — is a single argv element.
    expect(argvOf(sendCall!)).toContain(malicious);
    // And no escaping was applied to it.
    expect(argvOf(sendCall!).join(" ")).toContain("`cmux close-workspace`");
  });

  it("readPaneScreen calls cmux read-screen scoped to surface", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return "  some pane content  ";
      return "";
    });
    const text = await driver.readPaneScreen({ workspaceId: "workspace:1", surfaceId: "surface:9" });
    expect(text).toBe("some pane content");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("read-screen") && c.includes("--surface surface:9") && c.includes("--workspace workspace:1"))).toBe(true);
  });

  it("readPaneScreen returns empty string when cmux throws", async () => {
    execFileMock.mockImplementation(() => { throw new Error("dead"); });
    const text = await driver.readPaneScreen({ workspaceId: "workspace:1", surfaceId: "surface:9" });
    expect(text).toBe("");
  });

  // #258: when no draft is detected (cursor-only input box), deliver
  // message+Enter directly with no key-chord preamble. ctrl-u/ctrl+a/ctrl+k/
  // ctrl+y are all no-ops against Claude Code's input box.
  it("sendToSurface delivers message+Enter directly when no draft detected", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("\u276F \u258C");
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done");
    const calls = execFileMock.mock.calls.map(argvOf);

    // No kill-ring or ctrl-u keys
    expect(calls.every((a) => !a.includes("ctrl+a"))).toBe(true);
    expect(calls.every((a) => !a.includes("ctrl+k"))).toBe(true);
    expect(calls.every((a) => !a.includes("ctrl+y"))).toBe(true);
    expect(calls.every((a) => !a.includes("ctrl-u"))).toBe(true);
    // No backspaces either — nothing to clear
    expect(calls.every((a) => !a.includes("backspace"))).toBe(true);

    const msgIdx   = calls.findIndex((a) => a[0] === "send" && a.includes("crew done"));
    const enterIdx = calls.findIndex((a, i) => i > msgIdx && a.includes("send-key") && a.includes("Enter") && a.includes("surface:8"));
    expect(msgIdx, "message send exists").toBeGreaterThanOrEqual(0);
    expect(enterIdx, "Enter after message").toBeGreaterThan(msgIdx);
  });

  it("sendToSurface delivers shell metacharacters as literal text scoped to surface", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("\u276F \u258C");
      return "";
    });
    const text = 'done: `cmux close-workspace` $(whoami)';
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, text);
    const sendCall = execFileMock.mock.calls.find((c) => argvOf(c)[0] === "send");
    expect(sendCall).toBeDefined();
    expect(argvOf(sendCall!)).toContain(text);
    expect(cmdOf(sendCall!)).toContain("--surface surface:8");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("--surface surface:8") && c.includes("Enter"))).toBe(true);
  });

  // #117: background placement must NOT create a split-pane. cmux 0.62.2 has no
  // resize-pane verb, so a `new-pane --direction down` split can never be
  // shrunk and stays a full-height 50/50 split forever. A background tab
  // (new-surface) keeps the captain pane full-height with no split.
  it("spawnInjector background uses new-surface (no split-pane, no resize-pane)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("tree")) return 'surface surface:5 [terminal] "cap" [selected]';
      if (cmd.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    const pane = await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "cockpit notify-relay proj --as captain",
      title: "✉ notify-relay",
      placement: "background",
    });
    expect(pane).toEqual({ workspaceId: "workspace:1", surfaceId: "surface:8", title: "✉ notify-relay" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-surface") && c.includes("--workspace workspace:1"))).toBe(true);
    expect(cmds.every((c) => !c.includes("new-pane"))).toBe(true);
    expect(cmds.every((c) => !c.includes("--direction down"))).toBe(true);
    expect(cmds.every((c) => !c.includes("resize-pane"))).toBe(true);
  });

  it("spawnInjector background sends the command + Enter to the new surface", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("tree")) return 'surface surface:5 [terminal] "cap" [selected]';
      if (cmd.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "cockpit notify-relay proj --as captain",
      placement: "background",
    });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("send ") && c.includes("--surface surface:8") && c.includes("cockpit notify-relay proj") && !c.includes("send-key"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("--surface surface:8") && c.includes("Enter"))).toBe(true);
  });

  // The background relay tab must never steal focus from the captain: after
  // spawning it we re-select whichever surface was selected before, in its
  // original position.
  it("spawnInjector background restores focus to the previously-selected surface", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("tree")) {
        return [
          'surface surface:5 [terminal] "cap" [selected]',
          'surface surface:6 [terminal] "crew-1"',
        ].join("\n");
      }
      if (cmd.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "cockpit notify-relay proj --as captain",
      placement: "background",
    });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) =>
      c.includes("move-surface") &&
      c.includes("--surface surface:5") &&
      c.includes("--index 0") &&
      c.includes("--focus true"))).toBe(true);
  });

  it("spawnInjector visible uses new-surface and leaves the new tab focused (no refocus)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("tree")) return 'surface surface:5 [terminal] "cap" [selected]';
      if (cmd.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "cockpit notify-relay proj --as captain",
      placement: "visible",
    });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-surface"))).toBe(true);
    expect(cmds.every((c) => !c.includes("move-surface"))).toBe(true);
  });

  it("spawnInjector throws when new-surface returns no surface id", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.join(" ").includes("tree")) return "";
      return "garbage";
    });
    await expect(driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "x",
      placement: "background",
    })).rejects.toThrow(/did not return a surface/);
  });

  it("listSurfaces parses cmux tree output and returns surfaces with titles", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("tree")) {
        return [
          'window window:1 [current] ◀ active',
          '└── workspace workspace:10 "⚓ pact-network-captain"',
          '    └── pane pane:29 [focused]',
          '        ├── surface surface:29 [terminal] "✳ Run startup checklist" [selected]',
          '        ├── surface surface:30 [terminal] "🔧 pact-network:crew-1"',
          '        └── surface surface:31 [terminal] "🔧 pact-network:crew-2"',
        ].join("\n");
      }
      return "";
    });
    const surfaces = await driver.listSurfaces("workspace:10");
    expect(surfaces).toEqual([
      { workspaceId: "workspace:10", surfaceId: "surface:29", title: "✳ Run startup checklist" },
      { workspaceId: "workspace:10", surfaceId: "surface:30", title: "🔧 pact-network:crew-1" },
      { workspaceId: "workspace:10", surfaceId: "surface:31", title: "🔧 pact-network:crew-2" },
    ]);
  });

  it("listSurfaces returns empty array when cmux throws", async () => {
    execFileMock.mockImplementation(() => { throw new Error("workspace not found"); });
    const surfaces = await driver.listSurfaces("workspace:99");
    expect(surfaces).toEqual([]);
  });
});

describe("sendToSurface draft-preservation", () => {
  const driver = createCmuxDriver();

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("delivers directly when captain surface has no in-progress draft", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("❯ ▌");
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew is done");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    // No ctrl-u: no draft to clear
    expect(cmds.every((c) => !c.includes("ctrl-u"))).toBe(true);
    // One send (the message) and one send-key Enter
    const sends = cmds.filter((c) => c.includes("send ") && !c.includes("send-key"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("crew is done");
  });

  it("saves draft, clears input via backspaces, delivers, then restores draft without submitting (force=true)", async () => {
    // "hello this is my draft" = 22 chars → 24 backspaces (draft.length + 2 margin)
    const DRAFT = "hello this is my draft";
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) {
        return makeTestScreen(`│ > ${DRAFT}  │`, "│ Some conversation history │");
      }
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { force: true });
    const calls = execFileMock.mock.calls.map(argvOf);

    // No ctrl-u: that key is a no-op against Claude Code's input box
    expect(calls.every((a) => !a.includes("ctrl-u"))).toBe(true);

    // Backspaces must precede the message send
    const msgSendIdx = calls.findIndex((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")));
    const backspacesBefore = calls.slice(0, msgSendIdx).filter((a) => a.includes("send-key") && a.includes("backspace")).length;
    expect(backspacesBefore, "backspace count = draft.length + 2").toBe(DRAFT.length + 2);

    const enterIdx = calls.findIndex((a, i) => i > msgSendIdx && a.includes("send-key") && a.includes("Enter"));
    // findLastIndex is ES2023; reverse-scan manually to stay within repo's tsconfig target
    let restoreIdx = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      const a: string[] = calls[i];
      if (a[0] === "send" && a.some((s: string) => s.includes(DRAFT))) { restoreIdx = i; break; }
    }
    expect(msgSendIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx, "Enter after message").toBeGreaterThan(msgSendIdx);
    // Restore send comes after Enter (draft goes back without submitting)
    expect(restoreIdx, "restore after Enter").toBeGreaterThan(enterIdx);
    // Restore must NOT be followed by another Enter
    const cmdsAfterRestore = execFileMock.mock.calls.slice(restoreIdx + 1).map(cmdOf);
    expect(cmdsAfterRestore.every((c) => !c.includes("Enter"))).toBe(true);
  });

  // #268: unreadable screen → draft stays null → DeferDelivery (never deliver into unknown state).
  it("throws DeferDelivery when read-screen throws (surface unreadable — defer, not deliver)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) throw new Error("surface gone");
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done"),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const cmds = execFileMock.mock.calls.map(cmdOf);
    // Must not have sent anything — deferred
    expect(cmds.filter((c) => c.startsWith("send ") && !c.startsWith("send-key"))).toHaveLength(0);
  });
});

describe("parseDraftFromScreen", () => {
  it("returns null for empty screen (input box not confirmed visible — defer)", () => {
    expect(parseDraftFromScreen("")).toBeNull();
  });

  it("returns null when screen has no HR boundaries (overlay/unknown — must defer, not deliver)", () => {
    // No long ─ HR lines → cannot confirm input box → null signals DEFER (#268)
    const screen = "Claude Code\nsome transcript\n> looks like input but no HR box";
    expect(parseDraftFromScreen(screen)).toBeNull();
  });

  it("returns empty string when input box is empty (cursor only)", () => {
    const screen = makeTestScreen("❯ ▌");
    expect(parseDraftFromScreen(screen)).toBe("");
  });

  // (i) Happy path: real draft between HR rules above the status bar
  it("extracts draft from plain ‘❯ text’ input line between HR boundaries", () => {
    const screen = makeTestScreen("❯ my draft here", "Some history");
    expect(parseDraftFromScreen(screen)).toBe("my draft here");
  });

  it("extracts draft from plain ‘> text’ input line between HR boundaries", () => {
    const screen = makeTestScreen("> hello this is my draft", "Some history");
    expect(parseDraftFromScreen(screen)).toBe("hello this is my draft");
  });

  // (ii) Box-drawing content variant: │ ❯ text │ line inside the HR-bounded input box
  it("extracts draft from box-drawing input line between HR boundaries", () => {
    const screen = makeTestScreen("│ > my draft message  │");
    expect(parseDraftFromScreen(screen)).toBe("my draft message");
  });

  it("extracts draft from real Claude Code box-drawing prompt between HR boundaries", () => {
    const screen = makeTestScreen("│ ❯ my real draft message │");
    expect(parseDraftFromScreen(screen)).toBe("my real draft message");
  });

  // (iii) Regression: transcript above the top HR has ‘> sent message’ lines — must be ignored
  it("returns '' when input box is empty but transcript above contains sent '> ' lines", () => {
    const screen = makeTestScreen("❯ ", "> this is a sent message in the transcript");
    expect(parseDraftFromScreen(screen)).toBe("");
  });

  it("ignores transcript '> ' lines above the top HR, returns actual draft from input box", () => {
    const screen = makeTestScreen(
      "│ > actual draft       │",
      "> old prompt from history",
      "response text",
      "more history",
    );
    expect(parseDraftFromScreen(screen)).toBe("actual draft");
  });

  it("returns empty string when no prompt glyph inside the input box", () => {
    const screen = makeTestScreen("   thinking...   ", "   Claude Code   ");
    expect(parseDraftFromScreen(screen)).toBe("");
  });

  // Real Claude Code prompt uses ❯ (U+276F) + non-breaking space (U+00A0)
  it("extracts draft from real Claude Code prompt (❯ + non-breaking space)", () => {
    const screen = makeTestScreen("❯ hello draft text", "Some history");
    expect(parseDraftFromScreen(screen)).toBe("hello draft text");
  });

  it("returns empty string when real prompt has only cursor indicator (❯ ▌)", () => {
    const screen = makeTestScreen("│ ❯ ▌  │");
    expect(parseDraftFromScreen(screen)).toBe("");
  });

  // Regression fixture: real captain screen captured during the #258 bug.
  // Input box was empty (❯ with no text) but the transcript contained a sent
  // ❯ message — parseDraftFromScreen must return "" not the sent message.
  it("returns '' for real fixture: empty input box with sent ❯ lines in transcript (regression #258)", () => {
    const fixture = readFileSync(
      join(process.cwd(), "docs/reports/258-parse-bug-fixture.txt"),
      "utf-8",
    );
    expect(parseDraftFromScreen(fixture)).toBe("");
  });

  // #268: overlay/menu/scrolled screen — HR boundaries absent → input box NOT confirmed.
  // Must return null (not "") so the delivery gate knows to defer, never keystroke into unknown UI.
  it("returns null when screen has no HR boundaries (overlay / menu / scrolled-away input box)", () => {
    // No ─{10,} HR lines → topHR stays -1 → box not confirmed visible
    const overlayScreen = [
      " ╔══════════════════════════════════════╗",
      " ║  /model                              ║",
      " ║  ❯ claude-opus-4-8   (Powerful)      ║",
      " ║    claude-sonnet-4-6 (Fast)          ║",
      " ║  [Enter] Select  [Esc] Cancel        ║",
      " ╚══════════════════════════════════════╝",
      "   Model: Opus 4.8  Ctx Used: 31%",
    ].join("\n");
    expect(parseDraftFromScreen(overlayScreen)).toBeNull();
  });

  it("returns null for empty screen (input box not confirmed visible)", () => {
    expect(parseDraftFromScreen("")).toBeNull();
  });

  // Regression fixture: real overlay screen captured for #268.
  it("returns null for real overlay fixture (regression #268)", () => {
    const fixture = readFileSync(
      join(process.cwd(), "docs/reports/268-overlay-fixture.txt"),
      "utf-8",
    );
    expect(parseDraftFromScreen(fixture)).toBeNull();
  });
});

describe("sanitizeForCmuxSend", () => {
  it("collapses real newline bytes to single space", () => {
    expect(sanitizeForCmuxSend("line one\nline two")).toBe("line one line two");
  });

  it("collapses real CRLF to single space", () => {
    expect(sanitizeForCmuxSend("line one\r\nline two")).toBe("line one line two");
  });

  it("collapses real tab to single space", () => {
    expect(sanitizeForCmuxSend("col1\tcol2")).toBe("col1 col2");
  });

  it("collapses literal backslash-n escape to single space", () => {
    expect(sanitizeForCmuxSend("line one\\nline two")).toBe("line one line two");
  });

  it("collapses literal backslash-r escape to single space", () => {
    expect(sanitizeForCmuxSend("line one\\rline two")).toBe("line one line two");
  });

  it("collapses literal backslash-t escape to single space", () => {
    expect(sanitizeForCmuxSend("col1\\tcol2")).toBe("col1 col2");
  });

  it("handles mixed escapes and real whitespace", () => {
    expect(sanitizeForCmuxSend("a\\nb\\nc\r\nd\te")).toBe("a b c d e");
  });

  it("collapses multiple consecutive spaces from collapsed whitespace", () => {
    expect(sanitizeForCmuxSend("a\n\n\nb")).toBe("a b");
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeForCmuxSend("\n  hello world\n  ")).toBe("hello world");
  });

  it("preserves normal text without whitespace", () => {
    expect(sanitizeForCmuxSend("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(sanitizeForCmuxSend("")).toBe("");
  });
});

// #258 Approach B: deliver-only-when-empty. No 250ms stability double-read.
// Draft present → DeferDelivery (caller retries next poll until input is empty).
// Draft absent → deliver directly (nothing to protect, no backspaces).
// Draft + force → backspace clear, deliver, restore (walk-away last-resort).
describe("sendToSurface Approach B (#258 deliver-when-empty)", () => {
  const driver = createCmuxDriver();

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("non-empty draft, not forced → throws DeferDelivery immediately without sending", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("❯ hello draft text");
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done"),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const cmds = execFileMock.mock.calls.map(cmdOf);
    // Must not have attempted any send after the defer decision
    expect(cmds.filter((c) => c.startsWith("send ") && !c.startsWith("send-key"))).toHaveLength(0);
    expect(cmds.filter((c) => c.includes("Enter"))).toHaveLength(0);
  });

  it("empty input → delivers directly (no backspace, no restore)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("\u276F \u258C");
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done");
    const calls = execFileMock.mock.calls.map(argvOf);
    // No backspaces — nothing to clear
    expect(calls.every((a) => !a.includes("backspace"))).toBe(true);
    // Message delivered then Enter
    const msgIdx = calls.findIndex((a) => a[0] === "send" && a.includes("crew done"));
    const enterIdx = calls.findIndex((a, i) => i > msgIdx && a.includes("send-key") && a.includes("Enter"));
    expect(msgIdx, "message send").toBeGreaterThanOrEqual(0);
    expect(enterIdx, "Enter after message").toBeGreaterThan(msgIdx);
    // No restore send after Enter
    const afterEnter = calls.slice(enterIdx + 1);
    expect(afterEnter.filter((a) => a[0] === "send")).toHaveLength(0);
  });

  // #268: overlay / unknown screen → input box NOT positively confirmed → must defer,
  // never keystroke into an overlay or scrolled-away surface.
  it("throws DeferDelivery when read-screen returns a screen with no input-box boundaries (overlay/menu)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) {
        // No ─{10,} HR lines → parseDraftFromScreen returns null → must defer
        return [
          " ╔══════════════════════════════════════╗",
          " ║  /model                              ║",
          " ║  ❯ claude-opus-4-8   (Powerful)      ║",
          " ║    claude-sonnet-4-6 (Fast)          ║",
          " ║  [Enter] Select  [Esc] Cancel        ║",
          " ╚══════════════════════════════════════╝",
        ].join("\n");
      }
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done"),
    ).rejects.toBeInstanceOf(DeferDelivery);
    // Must not have sent anything into the overlay
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.filter((c) => c.startsWith("send ") && !c.startsWith("send-key"))).toHaveLength(0);
  });

  it("non-empty draft + force=true → backspace clear, deliver, restore without Enter", async () => {
    const DRAFT = "my walk-away draft";
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen(`❯ ${DRAFT}`);
      return "";
    });
    await driver.sendToSurface(
      { workspaceId: "workspace:3", surfaceId: "surface:8" },
      "crew done",
      { force: true },
    );
    const calls = execFileMock.mock.calls.map(argvOf);
    const msgIdx = calls.findIndex((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")));
    const backspacesBefore = calls.slice(0, msgIdx).filter((a) => a.includes("send-key") && a.includes("backspace")).length;
    expect(backspacesBefore, "backspace count = draft.length + 2").toBe(DRAFT.length + 2);
    const enterIdx = calls.findIndex((a, i) => i > msgIdx && a.includes("send-key") && a.includes("Enter"));
    let restoreIdx = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      const a: string[] = calls[i];
      if (a[0] === "send" && a.some((s: string) => s.includes(DRAFT))) { restoreIdx = i; break; }
    }
    expect(enterIdx, "Enter after message").toBeGreaterThan(msgIdx);
    expect(restoreIdx, "restore after Enter").toBeGreaterThan(enterIdx);
    // Restore must NOT be followed by another Enter
    const afterRestore = execFileMock.mock.calls.slice(restoreIdx + 1).map(cmdOf);
    expect(afterRestore.every((c) => !c.includes("Enter"))).toBe(true);
  });
});
