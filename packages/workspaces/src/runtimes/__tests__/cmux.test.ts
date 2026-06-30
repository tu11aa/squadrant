import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCmuxDriver, sanitizeForCmuxSend, parseDraftFromScreen, classifyStartupSurface, classifySendOutcome, classifyDraftLiveness } from "../cmux.js";
import { DeferDelivery } from "@squadrant/core";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  // Bridge: execFileMock is kept synchronous so assertions on mock.calls stay
  // unchanged; this wrapper adapts it to the callback-based execFile signature.
  execFile: (bin: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    try {
      const result = execFileMock(bin, args, opts);
      cb(null, result ?? "");
    } catch (err) {
      cb(err as Error, "");
    }
  },
}));

// cmux() now invokes execFile(CMUX_BIN, argv[], opts, callback) with no shell,
// so the command + its arguments arrive as an argv array (calls[i][1]). These
// helpers surface the argv for assertions; the binary path itself (calls[i][0])
// is irrelevant to behavior.
const argvOf = (call: unknown[]): string[] => call[1] as string[];
const cmdOf = (call: unknown[]): string => (call[1] as string[]).join(" ");

// Build a `cmux workspace list --json` payload for list()/status() tests (B2).
function wsListJson(...wss: { ref: string; title?: string; cwd?: string }[]): string {
  return JSON.stringify({
    window_ref: "window:1",
    workspaces: wss.map((w, i) => ({
      ref: w.ref,
      custom_title: w.title ?? null,
      has_custom_title: w.title != null,
      current_directory: w.cwd ?? "/home/u",
      index: i,
    })),
  });
}

// Build a `cmux tree --json` payload (one window/workspace/pane) for
// listSurfaces()/send() tests (B2).
function treeJson(workspaceRef: string, ...surfaces: { ref: string; title: string }[]): string {
  return JSON.stringify({
    windows: [{
      ref: "window:1",
      workspaces: [{
        ref: workspaceRef,
        panes: [{ ref: "pane:1", surfaces: surfaces.map((s, i) => ({ ref: s.ref, title: s.title, index: i })) }],
      }],
    }],
  });
}

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

    it("passes CMUX_QUIET=1 in the subprocess env to silence deprecation notices", async () => {
      execFileMock.mockReturnValue("");
      await driver.probe();
      const cmuxCall = execFileMock.mock.calls.find((c: unknown[]) =>
        (c[1] as string[]).includes("--version"),
      );
      expect(cmuxCall).toBeDefined();
      const env = (optsOf(cmuxCall as unknown[]).env) as Record<string, string>;
      expect(env.CMUX_QUIET).toBe("1");
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

  it("list parses `workspace list --json` into WorkspaceRefs (B2)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list") && args.includes("--json")) {
        return wsListJson(
          { ref: "workspace:1", title: "🏛️ command" },
          { ref: "workspace:2", title: "brove-captain" },
          { ref: "workspace:3", title: "⚡ reactor" },
        );
      }
      return "";
    });
    const refs = await driver.list();
    expect(refs).toHaveLength(3);
    expect(refs[1]).toEqual({ id: "workspace:2", name: "brove-captain", status: "running" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.startsWith("workspace list") && c.includes("--id-format refs"))).toBe(true);
    expect(cmds.every((c) => !c.includes("list-workspaces"))).toBe(true);
  });

  it("list falls back to cwd as the name for an untitled workspace", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list") && args.includes("--json")) {
        return wsListJson({ ref: "workspace:1", cwd: "/Users/u" });
      }
      return "";
    });
    const refs = await driver.list();
    expect(refs).toEqual([{ id: "workspace:1", name: "/Users/u", status: "running" }]);
  });

  it("list returns [] when the JSON payload is malformed", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list") && args.includes("--json")) return "not json";
      return "";
    });
    expect(await driver.list()).toEqual([]);
  });

  it("status returns null when name not in list", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list") && args.includes("--json")) return wsListJson({ ref: "workspace:1", title: "other-ws" });
      return "";
    });
    const ref = await driver.status("brove-captain");
    expect(ref).toBeNull();
  });

  it("status returns WorkspaceRef when name matches", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list") && args.includes("--json")) return wsListJson({ ref: "workspace:5", title: "brove-captain" });
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
      if (args.includes("list") && args.includes("--json")) return wsListJson({ ref: "workspace:2", title: "test-ws" });
      if (args.includes("tree"))                            return treeJson("workspace:2", { ref: "surface:5", title: "test-ws" });
      return "";
    });
    await driver.send("workspace:2", "hello tab");
    const cmds = execFileMock.mock.calls.map(cmdOf).filter((c) => !c.includes("list") && !c.includes("tree"));
    expect(cmds.some((c) => c.includes("send ") && c.includes("--surface surface:5") && c.includes("hello tab") && !c.includes("send-key"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("--surface surface:5") && c.includes("Enter"))).toBe(true);
  });

  it("send falls back to workspace-level when no surface matches workspace name", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("list") && args.includes("--json")) return wsListJson({ ref: "workspace:2", title: "test-ws" });
      if (args.includes("tree"))                            return treeJson("workspace:2", { ref: "surface:5", title: "crew-1" });
      return "";
    });
    await driver.send("workspace:2", "fallback message");
    const cmds = execFileMock.mock.calls.map(cmdOf).filter((c) => !c.includes("list") && !c.includes("tree"));
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

  it("stop unpins workspace then closes it ('workspace close' migrated from 'close-workspace')", async () => {
    execFileMock.mockReturnValue("");
    await driver.stop("workspace:2");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    const unpinIdx = cmds.findIndex((c) => c.includes("workspace-action") && c.includes("--action unpin") && c.includes("workspace:2"));
    const closeIdx = cmds.findIndex((c) => c.startsWith("workspace close") && c.includes("workspace:2"));
    expect(unpinIdx, "unpin call must exist").toBeGreaterThanOrEqual(0);
    expect(closeIdx, "close call must exist").toBeGreaterThanOrEqual(0);
    expect(unpinIdx, "unpin must precede close").toBeLessThan(closeIdx);
    expect(cmds.every((c) => !c.includes("close-workspace"))).toBe(true);
  });

  it("stop proceeds to close even when unpin throws (workspace may not be pinned)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("workspace-action")) throw new Error("cannot unpin");
      return "";
    });
    await driver.stop("workspace:2");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.startsWith("workspace close") && c.includes("workspace:2"))).toBe(true);
  });

  it("readScreen calls read-screen and returns output", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return "screen contents\n";
      return "";
    });
    const out = await driver.readScreen("workspace:2");
    expect(out).toBe("screen contents");
  });

  it("spawn calls 'workspace create' + 'workspace rename' (migrated verbs) and pins workspace and initial tab", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(" ");
      if (args[0] === "workspace" && args[1] === "create") return "Created workspace:7\n";
      if (cmd.includes("tree"))        return '  └── surface surface:1 [terminal] ""';
      return "";
    });
    const ref = await driver.spawn({ name: "test-ws", workdir: "/tmp", command: "echo hi", pinToTop: true });
    expect(ref.id).toBe("workspace:7");
    expect(ref.name).toBe("test-ws");
    const cmds = execFileMock.mock.calls.map(cmdOf);
    // Migrated: 'workspace create' not 'new-workspace'
    expect(cmds.some((c) => c.startsWith("workspace create"))).toBe(true);
    expect(cmds.every((c) => !c.includes("new-workspace"))).toBe(true);
    // Migrated: 'workspace rename id --title name' not 'rename-workspace --workspace id name'
    expect(cmds.some((c) => c.startsWith("workspace rename") && c.includes("--title") && c.includes("test-ws"))).toBe(true);
    expect(cmds.every((c) => !c.includes("rename-workspace"))).toBe(true);
    // Tab rename and pin unchanged
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

  // audit A1+B3: a crew tab must be created focus-neutrally. cmux 0.64.16's
  // new-surface defaults to --focus false; we pass it explicitly and NO LONGER
  // snapshot the tree or move-surface to restore focus (the old #295 dance,
  // which the 0.64 freeform canvas broke).
  it("newPane with direction=tab creates the surface with --focus false and no refocus dance", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-surface")) return "OK surface:8 workspace:1";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:1", direction: "tab" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-surface") && c.includes("--focus false"))).toBe(true);
    // No tree snapshot, no move-surface, never asks for focus true.
    expect(cmds.every((c) => !c.includes("tree"))).toBe(true);
    expect(cmds.every((c) => !c.includes("move-surface"))).toBe(true);
    expect(cmds.every((c) => !c.includes("--focus true"))).toBe(true);
  });

  it("newPane with split direction creates the pane with --focus false and queries nothing", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-pane")) return "OK surface:27 pane:25 workspace:1";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:1", direction: "right" });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-pane") && c.includes("--focus false"))).toBe(true);
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
      if (args.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    const pane = await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "squadrant notify-relay proj --as captain",
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
      if (args.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "squadrant notify-relay proj --as captain",
      placement: "background",
    });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("send ") && c.includes("--surface surface:8") && c.includes("squadrant notify-relay proj") && !c.includes("send-key"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-key") && c.includes("--surface surface:8") && c.includes("Enter"))).toBe(true);
  });

  // audit A1+B3: the background relay tab must never steal focus from the
  // captain. cmux 0.64.16's new-surface defaults to --focus false, so we pass it
  // explicitly and DROP the old snapshot-then-move-surface refocus dance.
  it("spawnInjector background creates the surface with --focus false and no refocus dance", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "squadrant notify-relay proj --as captain",
      placement: "background",
    });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-surface") && c.includes("--focus false"))).toBe(true);
    expect(cmds.every((c) => !c.includes("tree"))).toBe(true);
    expect(cmds.every((c) => !c.includes("move-surface"))).toBe(true);
    expect(cmds.every((c) => !c.includes("--focus true"))).toBe(true);
  });

  it("spawnInjector visible creates the surface with --focus true and no refocus dance", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("new-surface")) return "OK surface:8 pane:2 workspace:1";
      return "";
    });
    await driver.spawnInjector({
      captainWorkspace: { id: "workspace:1", name: "cap", status: "running" },
      command: "squadrant notify-relay proj --as captain",
      placement: "visible",
    });
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("new-surface") && c.includes("--focus true"))).toBe(true);
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

  it("listSurfaces parses `tree --json` and returns surfaces with titles (B2)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("tree")) {
        return treeJson(
          "workspace:10",
          { ref: "surface:29", title: "✳ Run startup checklist" },
          { ref: "surface:30", title: "🔧 pact-network:crew-1" },
          { ref: "surface:31", title: "🔧 pact-network:crew-2" },
        );
      }
      return "";
    });
    const surfaces = await driver.listSurfaces("workspace:10");
    expect(surfaces).toEqual([
      { workspaceId: "workspace:10", surfaceId: "surface:29", title: "✳ Run startup checklist" },
      { workspaceId: "workspace:10", surfaceId: "surface:30", title: "🔧 pact-network:crew-1" },
      { workspaceId: "workspace:10", surfaceId: "surface:31", title: "🔧 pact-network:crew-2" },
    ]);
    // The tree read must request both JSON (B2) and refs id-format (#325).
    const cmds = execFileMock.mock.calls.map(cmdOf);
    expect(cmds.some((c) => c.includes("tree") && c.includes("--json"))).toBe(true);
    expect(cmds.some((c) => c.includes("tree") && c.includes("--id-format refs"))).toBe(true);
  });

  it("listSurfaces only returns surfaces of the requested workspace", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("tree")) {
        return JSON.stringify({
          windows: [{
            ref: "window:1",
            workspaces: [
              { ref: "workspace:10", panes: [{ surfaces: [{ ref: "surface:1", title: "keep" }] }] },
              { ref: "workspace:99", panes: [{ surfaces: [{ ref: "surface:2", title: "skip" }] }] },
            ],
          }],
        });
      }
      return "";
    });
    const surfaces = await driver.listSurfaces("workspace:10");
    expect(surfaces).toEqual([{ workspaceId: "workspace:10", surfaceId: "surface:1", title: "keep" }]);
  });

  it("listSurfaces returns empty array when cmux throws", async () => {
    execFileMock.mockImplementation(() => { throw new Error("workspace not found"); });
    const surfaces = await driver.listSurfaces("workspace:99");
    expect(surfaces).toEqual([]);
  });

  it("listSurfaces returns empty array when the JSON payload is malformed", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("tree")) return "not json";
      return "";
    });
    expect(await driver.listSurfaces("workspace:10")).toEqual([]);
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

  // #302 — the old destructive force path (backspace×N clear + re-paste the
  // screen-read draft) is replaced by a non-destructive BUFFER-LIVENESS PROBE.
  // Verified live (CC 2.1.x): a real draft is the ONLY thing that yields the
  // "last char removed, still non-empty" signature under ONE backspace; a ghost
  // either stays invariant or dismisses to empty. So the probe protects ONLY a
  // real draft and NEVER re-pastes screen-read content (the materialization vector).
  //
  // Stateful mock of CC's input box: `box` is the content rendered between the
  // HRs; one backspace transforms it per `onBackspace`; read-screen renders the
  // current box. This lets a probe observe a DIFFERENT screen before vs after.
  function probeMock(initial: string, onBackspace: (s: string) => string) {
    let box = initial;
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen(`❯ ${box}`);
      if (args.includes("send-key") && args.includes("backspace")) { box = onBackspace(box); return ""; }
      return "";
    });
  }

  it("probe: real draft (last-char-removal signature) → restores the one removed char and defers; never re-pastes the draft, never delivers", async () => {
    const DRAFT = "hello world";
    probeMock(DRAFT, (s) => s.slice(0, -1)); // real draft: backspace removes exactly the last char
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const calls = execFileMock.mock.calls.map(argvOf);
    // Exactly ONE backspace — the probe, NOT a backspace×N clear
    expect(calls.filter((a) => a.includes("send-key") && a.includes("backspace"))).toHaveLength(1);
    // Crew message must NEVER be delivered (we deferred to protect the draft)
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(false);
    // The full draft must NEVER be re-pasted (this was the #302 materialization vector)
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes(DRAFT)))).toBe(false);
    // Only the single removed char ("d") is restored
    const sends = calls.filter((a) => a[0] === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0][sends[0].length - 1]).toBe("d");
  });

  // #258 emoji fix: trailing emoji (surrogate pair) is correctly classified as
  // real-draft and the FULL grapheme (not a lone broken surrogate) is restored.
  it("probe: real draft ending in emoji (😀, surrogate pair) → defers and restores the full grapheme, never re-pastes draft", async () => {
    const DRAFT = "hello 😀";
    // Terminal backspace removes the 😀 grapheme; readInputBoxRaw trims trailing
    // space → box shows "hello" → probeMock simulates this transformation.
    probeMock(DRAFT, () => "hello");
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const calls = execFileMock.mock.calls.map(argvOf);
    // Full draft must NEVER be re-pasted
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes(DRAFT)))).toBe(false);
    // Crew message NOT delivered
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(false);
    // The restored char must be the full emoji grapheme, not a broken surrogate
    const sends = calls.filter((a) => a[0] === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0][sends[0].length - 1]).toBe("😀");
  });

  it("probe: ghost that DISMISSES to empty under backspace → delivers message+Enter, NEVER re-sends the ghost text (#302 materialization regression)", async () => {
    const GHOST = "wait for both crews to finish";
    probeMock(GHOST, () => ""); // verified live: the #294 queue ghost dismisses to empty
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true });
    const calls = execFileMock.mock.calls.map(argvOf);
    // The ghost text is NEVER typed back into the box
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("wait for both crews")))).toBe(false);
    // The crew message IS delivered and submitted
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(true);
    expect(calls.some((a) => a.includes("send-key") && a.includes("Enter"))).toBe(true);
  });

  // Ghost-invariant fix: when backspace is a true no-op on BOTH trimmed AND raw
  // content (rawBefore===rawAfter), the box holds non-editable ghost/hint text —
  // a real draft ALWAYS changes under backspace. Deliver immediately; never defer.
  // Ghost text is still never re-pasted (no materialization vector).
  it("probe: ghost INVARIANT under backspace (stays identical) → DELIVERS (ghost is non-editable, not a real draft)", async () => {
    const GHOST = "some persistent suggestion";
    probeMock(GHOST, (s) => s); // invariant: backspace is a no-op on non-buffer ghost
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).resolves.toBeUndefined();
    const calls = execFileMock.mock.calls.map(argvOf);
    // Ghost text is never re-pasted
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("persistent suggestion")))).toBe(false);
    // Crew message IS delivered
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(true);
    // Enter is submitted
    expect(calls.some((a) => a.includes("send-key") && a.includes("Enter"))).toBe(true);
  });

  // Ghost-defer regression (#258 anti-clobber introduced a regression where a
  // history/hint ghost text — "go — publish it", "wait for both crews to finish" —
  // that is invariant under the backspace probe (rawBefore===rawAfter) caused
  // delivery to defer indefinitely. Because the ghost is non-editable the backspace
  // is a true no-op on both trimmed AND untrimmed content, giving the clean
  // discrimination: invariant ⇒ not a real draft ⇒ DELIVER.
  //
  // RED test: currently DEFERS (bug). Fix: DELIVERS.
  it("probe: ghost hint invariant under backspace (rawBefore===rawAfter, non-empty box) → DELIVERS (not defers) [ghost-defer regression]", async () => {
    const GHOST = "go — publish it";
    // Ghost: backspace is a true no-op on raw AND trimmed content.
    probeMock(GHOST, (s) => s);
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).resolves.toBeUndefined(); // MUST deliver, not defer
    const calls = execFileMock.mock.calls.map(argvOf);
    // Crew message IS delivered
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(true);
    // Ghost text is never typed back into the box (no materialization)
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("go — publish it")))).toBe(false);
    // Enter is submitted
    expect(calls.some((a) => a.includes("send-key") && a.includes("Enter"))).toBe(true);
  });

  // Regression guard: trailing-space real draft must still DEFER after the ghost fix.
  // rawBefore="hello " (untrimmed) → backspace removes the space → rawAfter="hello"
  // → rawBefore !== rawAfter → real editable content → restore + defer.
  it("probe: trailing-space real draft (rawBefore !== rawAfter) → still DEFERS (no-clobber regression guard)", async () => {
    let rawBox = "hello "; // trailing space removed by backspace
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen(`❯ ${rawBox}`);
      if (args.includes("send-key") && args.includes("backspace")) { rawBox = rawBox.slice(0, -1); return ""; }
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const calls = execFileMock.mock.calls.map(argvOf);
    // Crew message NOT delivered
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(false);
    // The trailing space is restored
    const sends = calls.filter((a) => a[0] === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0][sends[0].length - 1]).toBe(" ");
  });

  // #258 trailing-space residual: probe removes the trailing space (which readInputBoxRaw
  // trimmed, so before===after in the trimmed view → inconclusive). The RAW (untrimmed)
  // comparison detects the change and restores the space before deferring — the user's
  // draft is left intact as "hello ", not mutated to "hello".
  it("probe: trailing-space draft (inconclusive) → defers AND restores the space (draft preserved)", async () => {
    let rawBox = "hello "; // trailing space — readInputBoxRaw trims it away → before="hello"
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen(`❯ ${rawBox}`);
      if (args.includes("send-key") && args.includes("backspace")) {
        rawBox = rawBox.slice(0, -1); // backspace removes the trailing space from terminal
        return "";
      }
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const calls = execFileMock.mock.calls.map(argvOf);
    // Crew message NOT delivered
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(false);
    // The trailing space is restored — exactly one send(), and it sends " "
    const sends = calls.filter((a) => a[0] === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0][sends[0].length - 1]).toBe(" ");
  });

  it("non-probe call with a draft present defers WITHOUT any keystroke (hot path unchanged — never races typing)", async () => {
    probeMock("typing in progress", (s) => s.slice(0, -1));
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done"),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const calls = execFileMock.mock.calls.map(argvOf);
    expect(calls.some((a) => a.includes("backspace"))).toBe(false);
    expect(calls.some((a) => a[0] === "send")).toBe(false);
  });

  it("DeferDelivery carries the observed draft text so the relay can track content stability", async () => {
    probeMock("my draft text", (s) => s.slice(0, -1));
    let caught: unknown;
    try {
      await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done");
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DeferDelivery);
    expect((caught as DeferDelivery).draft).toBe("my draft text");
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

// #339: debug-gated send instrumentation. The DONE→captain submit is a text
// burst then a SEPARATE send-key Enter; intermittently the Enter mis-lands as a
// newline, stranding the payload in the input box. SQUADRANT_DEBUG_SEND turns on a
// pre-send + post-send read-back that logs one real frame so the fault can be
// caught in the wild. It must be a strict no-op (no extra reads, no log) when off
// and must NEVER re-send (no double-submit).
describe("sendToSurface #339 send instrumentation (SQUADRANT_DEBUG_SEND)", () => {
  const driver = createCmuxDriver();
  let stderrWrites: string[];
  let restoreStderr: () => void;

  beforeEach(() => {
    execFileMock.mockReset();
    stderrWrites = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    restoreStderr = () => spy.mockRestore();
    delete process.env.SQUADRANT_DEBUG_SEND;
  });

  afterEach(() => {
    restoreStderr();
    delete process.env.SQUADRANT_DEBUG_SEND;
  });

  it("is silent and adds no extra read-screen when the flag is unset", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("❯ ▌");
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done");
    // No send-debug line emitted
    expect(stderrWrites.some((w) => w.includes("send-debug"))).toBe(false);
    // Exactly the gate's single read-screen — no pre/post read-back added
    const reads = execFileMock.mock.calls.map(argvOf).filter((a) => a.includes("read-screen"));
    expect(reads).toHaveLength(1);
  });

  it("logs a 'submitted' frame and never re-sends when the box is empty after Enter", async () => {
    process.env.SQUADRANT_DEBUG_SEND = "1";
    // Box empty before AND after — a clean submit.
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("❯ ▌");
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done");

    // The instrumentation added a pre-send and a post-send read-back (3 reads total).
    const reads = execFileMock.mock.calls.map(argvOf).filter((a) => a.includes("read-screen"));
    expect(reads).toHaveLength(3);

    // Exactly ONE payload send + ONE Enter — the read-back never re-submits.
    const calls = execFileMock.mock.calls.map(argvOf);
    expect(calls.filter((a) => a[0] === "send" && a.includes("crew done"))).toHaveLength(1);
    expect(calls.filter((a) => a.includes("send-key") && a.includes("Enter"))).toHaveLength(1);

    const debugLine = stderrWrites.find((w) => w.includes("send-debug"));
    expect(debugLine).toBeDefined();
    const frame = JSON.parse(debugLine!.replace(/^\[squadrant\] send-debug /, "").trim());
    expect(frame.surface).toBe("surface:8");
    expect(frame.payload).toBe("crew done");
    expect(frame.verdict).toBe("submitted");
  });

  it("logs a 'stuck' frame when the input box still holds the payload after Enter", async () => {
    process.env.SQUADRANT_DEBUG_SEND = "1";
    // Empty at the gate read (so we deliver), then the payload is stranded in the
    // box on the post-send read-back — the #339 fault signature.
    let reads = 0;
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) {
        reads++;
        // gate (1) + pre-send (2) see an empty box; post-send (3) shows it stuck.
        return reads >= 3 ? makeTestScreen("❯ crew done") : makeTestScreen("❯ ▌");
      }
      return "";
    });
    await driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done");

    const debugLine = stderrWrites.find((w) => w.includes("send-debug"));
    expect(debugLine).toBeDefined();
    const frame = JSON.parse(debugLine!.replace(/^\[squadrant\] send-debug /, "").trim());
    expect(frame.verdict).toBe("stuck");
    expect(frame.postBox).toContain("crew done");
  });
});

describe("classifySendOutcome (#339 verdict)", () => {
  it("returns 'submitted' for an empty post-send box", () => {
    expect(classifySendOutcome("crew done", "")).toBe("submitted");
  });
  it("returns 'stuck' when the box still holds the payload", () => {
    expect(classifySendOutcome("crew done", "crew done")).toBe("stuck");
  });
  it("returns 'box-gone' when the box is not visible (null)", () => {
    expect(classifySendOutcome("crew done", null)).toBe("box-gone");
  });
  it("returns 'unknown' for unrelated box content", () => {
    expect(classifySendOutcome("crew done", "a fresh draft")).toBe("unknown");
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

  // #294: Claude Code ghost-suggestion placeholder must be treated as empty.
  // "Press up to edit queued messages" is a CC UI hint, NOT user-typed content.
  // Captured from a live captain in Working state: ❯ + U+00A0 NBSP + ghost text, no cursor block.
  it("returns '' for CC ghost 'Press up to edit queued messages' (Working state, no cursor — #294)", () => {
    // U+276F ❯, U+00A0 NBSP, then the placeholder text CC shows when there are queued messages
    const screen = makeTestScreen("❯\xa0Press up to edit queued messages");
    expect(parseDraftFromScreen(screen)).toBe("");
  });

  // #294: idle-state variant — cursor block appears at position 0 BEFORE the ghost text.
  // Leading ▌ means cursor is at the start, so nothing has actually been typed.
  it("returns '' when cursor block precedes ghost text in idle state (leading cursor = empty — #294)", () => {
    const screen = makeTestScreen("❯\xa0▌Press up to edit queued messages");
    expect(parseDraftFromScreen(screen)).toBe("");
  });

  // Regression guard (#258): real typed draft must still return its text after #294 fix.
  it("still returns real draft text after #294 fix (regression guard for #258)", () => {
    const screen = makeTestScreen("❯\xa0hello world");
    expect(parseDraftFromScreen(screen)).toBe("hello world");
  });

  // Captain follow-up on #297: if user types "hello world" then presses Ctrl-A/Home to move
  // the cursor to the start, does cmux read-screen render "❯\xa0▌hello world" (leading ▌)?
  // Verified: CC uses native ANSI cursor positioning, NOT a ▌ glyph — cursor-at-position-0
  // on an idle CC session captures as ❯\xa0 (0xe2 0x9d 0xaf 0xc2 0xa0, no 0xe2 0x96 0x8c).
  // cmux read-screen output is ❯\xa0hello world regardless of cursor position.
  // Heuristic #1 (/^[▌█]/ skip) is therefore unreachable for real typed drafts — no clobber.
  it("returns real draft when cursor is at start of typed text (no leading ▌ in CC output — #297)", () => {
    // This is exactly what cmux read-screen yields after: type "hello world", press Ctrl-A.
    const screen = makeTestScreen("❯\xa0hello world");
    expect(parseDraftFromScreen(screen)).toBe("hello world");
  });

  // Regression fixture: real ghost screen captured from live captain during #294.
  // Input box between HR boundaries contains ❯\xa0<ghost> — must return "".
  it("returns '' for real ghost-placeholder fixture (regression #294)", () => {
    const fixture = readFileSync(
      join(process.cwd(), "docs/reports/294-ghost-placeholder-fixture.txt"),
      "utf-8",
    );
    expect(parseDraftFromScreen(fixture)).toBe("");
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

  // #294: ghost placeholder must NOT trigger DeferDelivery — deliver immediately.
  it("delivers immediately when input shows CC ghost placeholder (no DeferDelivery — #294)", async () => {
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen("❯\xa0Press up to edit queued messages");
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done"),
    ).resolves.toBeUndefined();
    const calls = execFileMock.mock.calls.map(argvOf);
    const msgIdx = calls.findIndex((a) => a[0] === "send" && a.includes("crew done"));
    expect(msgIdx, "message was delivered").toBeGreaterThanOrEqual(0);
    // No backspaces — ghost is not real content
    expect(calls.every((a) => !a.includes("backspace"))).toBe(true);
  });

  // #302: a real walk-away draft under {probe:true} is detected by the
  // last-char-removal signature → restore + defer; it is NEVER force-delivered
  // (the old backspace×N clear + re-paste, which materialized ghosts, is gone).
  it("real walk-away draft + probe=true → one backspace, restore one char, defers (never force-clobbers)", async () => {
    const DRAFT = "my walk-away draft";
    let box = DRAFT;
    execFileMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("read-screen")) return makeTestScreen(`❯ ${box}`);
      if (args.includes("send-key") && args.includes("backspace")) { box = box.slice(0, -1); return ""; }
      return "";
    });
    await expect(
      driver.sendToSurface({ workspaceId: "workspace:3", surfaceId: "surface:8" }, "crew done", { probe: true }),
    ).rejects.toBeInstanceOf(DeferDelivery);
    const calls = execFileMock.mock.calls.map(argvOf);
    // Exactly ONE backspace (the probe), not draft.length+2
    expect(calls.filter((a) => a.includes("send-key") && a.includes("backspace"))).toHaveLength(1);
    // Message NOT delivered, full draft NEVER re-pasted, no Enter submitted
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes("crew done")))).toBe(false);
    expect(calls.some((a) => a[0] === "send" && a.some((s: string) => s.includes(DRAFT)))).toBe(false);
    expect(calls.some((a) => a.includes("send-key") && a.includes("Enter"))).toBe(false);
  });
});

// #292: deterministic startup-prompt delivery needs to tell three surface states
// apart so launch can wait out cold init, send when ready, and never re-send into
// a working session. The signals are grounded in real read-screen captures:
//   loading — splash/cold-init: none of the persistent CC bottom-status chrome yet
//   idle    — TUI up, input box accepting keystrokes (⏵⏵ / Ctx Used / for shortcuts)
//   working — a live turn: token-down-counter "↓ Nk tokens" and/or "esc to interrupt"
describe("classifyStartupSurface (#292 startup-readiness classifier)", () => {
  // Real CC working spinner line (see docs/reports/258-parse-bug-fixture.txt).
  const WORKING_STATUS = [
    "✢ Cerebrating… (1m 4s · ↓ 4.3k tokens)",
    HR,
    "❯ ",
    HR,
    "   Model: Opus 4.8  Ctx Used: 52.0%",
    "  ⏵⏵ auto mode on · 1 shell",
  ].join("\n");

  it("returns 'loading' for an empty screen", () => {
    expect(classifyStartupSurface("")).toBe("loading");
  });

  it("returns 'loading' for a cold-init splash with no CC status chrome", () => {
    const splash = ["", " ✻ Welcome to Claude Code", "   Loading…", ""].join("\n");
    expect(classifyStartupSurface(splash)).toBe("loading");
  });

  it("returns 'idle' once the CC bottom-status chrome is present and no turn is running", () => {
    // makeTestScreen renders the real idle layout: HR-boxed empty ❯ + status block.
    expect(classifyStartupSurface(makeTestScreen("❯ "))).toBe("idle");
  });

  it("returns 'working' when the live token-down-counter is on screen", () => {
    expect(classifyStartupSurface(WORKING_STATUS)).toBe("working");
  });

  it("returns 'working' when 'esc to interrupt' is shown", () => {
    const screen = makeTestScreen("❯ ", "Working… (3s · esc to interrupt)");
    expect(classifyStartupSurface(screen)).toBe("working");
  });

  it("prefers 'working' over 'idle' when both chrome and a live turn are present", () => {
    // The 258 fixture shape: idle-looking input box but an active spinner above.
    expect(classifyStartupSurface(WORKING_STATUS)).toBe("working");
  });
});

// #258 probe false-negative cases — RED tests (Step-1: assert DESIRED behavior
// which FAILS against the current slice(0,-1) logic).
//
// The current classifier misses two false-negative triggers and would fall
// through to deliver() — clobbering a real in-progress user draft:
//
//  1. trailing-space: readInputBoxRaw trims trailing whitespace, so a draft
//     ending in " " produces before="hello" AFTER the trim. Backspace removes
//     the space from the terminal; box now reads "hello" too → after="hello".
//     before === after (looks invariant), NOT before.slice(0,-1) → 'no-draft'
//     → deliver → CLOBBER.
//
//  2. trailing emoji (wide/surrogate-pair char): backspace removes one grapheme
//     ("😀" = U+1F600 = 😀); after="hello " trimmed to "hello".
//     before.slice(0,-1) removes only the low surrogate (\uDE00), yielding
//     "hello \uD83D" (broken) ≠ "hello" → 'no-draft' → deliver → CLOBBER.
//
// These tests FAIL on the current Step-1 classifier (it returns 'no-draft' for
// both). They become GREEN in Step-2 after the fix.
describe("classifyDraftLiveness (#258 probe false-negative detection)", () => {
  it("returns 'real-draft' for ASCII draft that is 1 char shorter (sanity: positive detection still works)", () => {
    // "hello world" → backspace removes 'd' → "hello worl"
    expect(classifyDraftLiveness("hello world", "hello worl")).toBe("real-draft");
  });

  it("trailing-space: before='hello', after='hello' → 'inconclusive' (should NOT be no-draft)", () => {
    // User typed "hello " — readInputBoxRaw trims → before="hello".
    // Backspace removes the space from the terminal box: renders "hello" → after="hello".
    // Current logic: after !== before.slice(0,-1) ("hell") → 'no-draft' → delivers → CLOBBER.
    // Desired: 'inconclusive' — ambiguous between ghost-invariant and trailing-space draft;
    // MUST defer rather than risk clobbering the human's real content.
    expect(classifyDraftLiveness("hello", "hello")).toBe("inconclusive");
  });

  it("trailing emoji (surrogate pair): before='hello \\uD83D\\uDE00', after='hello' → 'real-draft'", () => {
    // User typed "hello 😀" (U+1F600 = surrogate pair 😀).
    // readInputBoxRaw: before="hello 😀" (no trailing whitespace to trim).
    // Backspace removes the 😀 grapheme; terminal now shows "hello " → trimmed → after="hello".
    // Current logic: before.slice(0,-1) = "hello \uD83D" (broken surrogate) ≠ "hello" → 'no-draft' → CLOBBER.
    // Desired: 'real-draft' (grapheme-aware detection: drop last grapheme "😀" → "hello " → trim → "hello").
    expect(classifyDraftLiveness("hello 😀", "hello")).toBe("real-draft");
  });
});
