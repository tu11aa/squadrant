import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCmuxDriver } from "../cmux.js";

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

describe("cmux driver", () => {
  const driver = createCmuxDriver();

  beforeEach(() => {
    execFileMock.mockReset();
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

  it("sendToSurface delivers shell metacharacters as literal text scoped to surface", async () => {
    execFileMock.mockReturnValue("");
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
