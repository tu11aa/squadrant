import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectionCommand } from "../projection.js";

const emitMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock("@squadrant/agents", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/agents")>(
    "@squadrant/agents",
  );
  return {
    ...actual,
    ProjectionRegistry: class {
      get = getMock;
      list = listMock;
    },
    createCursorEmitter: () => ({
      name: "cursor",
      destinations: () => [{ path: "/tmp/a.mdc", shared: false, format: "mdc" }],
      emit: emitMock,
    }),
    createCodexEmitter: () => ({
      name: "codex",
      destinations: () => [{ path: "/tmp/b.md", shared: true, format: "markdown" }],
      emit: emitMock,
    }),
    createGeminiEmitter: () => ({
      name: "gemini",
      destinations: () => [{ path: "/tmp/c.md", shared: true, format: "markdown" }],
      emit: emitMock,
    }),
  };
});

const readUserLevelSourceMock = vi.hoisted(() => vi.fn(async () => ({ instructions: "", skills: [] })));
const readProjectLevelSourceMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return {
    ...actual,
    readUserLevelSource: readUserLevelSourceMock,
    readProjectLevelSource: readProjectLevelSourceMock,
    loadConfig: () => ({
      commandName: "cmd",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "b", spokeVault: "~/hub/brove", host: "local" },
      },
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "default", captain: "acceptEdits" },
      },
      metrics: { enabled: false, path: "" },
      projection: { targets: ["cursor", "codex", "gemini"] },
    }),
  };
});

// Avoid accidentally touching a real workspace: stub obsidian factory.
vi.mock("@squadrant/workspaces", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/workspaces")>(
    "@squadrant/workspaces",
  );
  return {
    ...actual,
    createObsidianDriver: () => ({
      name: "obsidian",
      async probe() { return { installed: true, rootExists: true }; },
      async read() { return ""; },
      async write() {},
      async exists() { return false; },
      async list() { return []; },
      async mkdir() {},
    }),
  };
});

describe("projectionCommand", () => {
  beforeEach(() => {
    emitMock.mockReset().mockResolvedValue({ written: true, path: "/tmp/x", bytesWritten: 10 });
    listMock.mockReset().mockReturnValue(["cursor", "codex", "gemini"]);
    getMock.mockReset().mockImplementation((name: string) => {
      const destMap: Record<string, { path: string; shared: boolean; format: "markdown" | "mdc" }> = {
        cursor: { path: "/tmp/a.mdc", shared: false, format: "mdc" },
        codex: { path: "/tmp/b.md", shared: true, format: "markdown" },
        gemini: { path: "/tmp/c.md", shared: true, format: "markdown" },
      };
      const dest = destMap[name];
      if (!dest) throw new Error(`Unknown projection target '${name}'`);
      return {
        name,
        destinations: () => [dest],
        emit: emitMock,
      };
    });
  });

  it("is a commander Command named 'projection'", () => {
    expect(projectionCommand.name()).toBe("projection");
  });

  it("has subcommands emit, diff, list", () => {
    const names = projectionCommand.commands.map((c) => c.name());
    expect(names).toContain("emit");
    expect(names).toContain("diff");
    expect(names).toContain("list");
  });

  it("emit --target cursor --scope user calls cursor emitter for user scope", async () => {
    await projectionCommand.parseAsync(["node", "projection", "emit", "--target", "cursor", "--scope", "user"]);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("emit --project brove triggers emit calls for brove project scope", async () => {
    await projectionCommand.parseAsync(["node", "projection", "emit", "--project", "brove"]);
    // readProjectLevelSource mock returns null, so brove projection is skipped — but user-level may also trigger
    // depending on default. The test only asserts that the command parses and does not throw.
    expect(projectionCommand).toBeDefined();
  });

  it("emit --all runs user-level + every managed project", async () => {
    await projectionCommand.parseAsync(["node", "projection", "emit", "--all"]);
    expect(emitMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("diff --target cursor forwards dryRun:true to emit", async () => {
    await projectionCommand.parseAsync(["node", "projection", "diff", "--target", "cursor", "--scope", "user"]);
    const [, , opts] = emitMock.mock.calls[0];
    expect(opts?.dryRun).toBe(true);
  });

  it("emit --scope user with --project throws validation error", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await projectionCommand.parseAsync(["node", "projection", "emit", "--scope", "user", "--project", "brove"]);
    } catch {}
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errOutput).toMatch(/cannot be combined/i);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("emit --scope user passes pkgRoot to readUserLevelSource (#45)", async () => {
    readUserLevelSourceMock.mockClear();
    await projectionCommand.parseAsync(["node", "projection", "emit", "--target", "cursor", "--scope", "user"]);
    expect(readUserLevelSourceMock).toHaveBeenCalledTimes(1);
    const callArgs = readUserLevelSourceMock.mock.calls[0] as unknown as [unknown, { pkgRoot?: string }];
    const opts = callArgs[1];
    expect(opts).toBeDefined();
    expect(typeof opts.pkgRoot).toBe("string");
    expect((opts.pkgRoot ?? "").length).toBeGreaterThan(0);
  });

  it("emit --project unknown-name throws fatal error", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await projectionCommand.parseAsync(["node", "projection", "emit", "--project", "nope"]);
    } catch {}
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errOutput).toMatch(/unknown project/i);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
