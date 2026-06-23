import { describe, it, expect } from "vitest";
import { parseCommand, WRITABLE_CONFIG_KEYS } from "./commands.js";

describe("parseCommand", () => {
  it("maps /status to argv", () => {
    expect(parseCommand("/status")).toEqual({ kind: "ok", name: "status", argv: ["status"] });
  });

  it("maps /projects to the real CLI subcommand", () => {
    expect(parseCommand("/projects")).toEqual({ kind: "ok", name: "projects", argv: ["projects", "list"] });
  });

  it("requires a project for /crews and builds crew list argv", () => {
    expect(parseCommand("/crews").kind).toBe("usage");
    expect(parseCommand("/crews brove")).toEqual({ kind: "ok", name: "crews", argv: ["crew", "list", "brove"] });
  });

  it("requires a project for /launch", () => {
    expect(parseCommand("/launch").kind).toBe("usage");
    expect(parseCommand("/launch brove")).toEqual({ kind: "ok", name: "launch", argv: ["launch", "brove"] });
  });

  it("reads and sets the effort dial", () => {
    expect(parseCommand("/effort")).toEqual({ kind: "ok", name: "effort", argv: ["effort"] });
    expect(parseCommand("/effort low")).toEqual({ kind: "ok", name: "effort", argv: ["effort", "low"] });
    expect(parseCommand("/effort bogus").kind).toBe("usage");
  });

  it("requires a key for /config get", () => {
    expect(parseCommand("/config get").kind).toBe("usage");
    expect(parseCommand("/config get defaults.effort")).toEqual({
      kind: "ok",
      name: "config",
      argv: ["config", "get", "defaults.effort"],
    });
  });

  it("denies /config set on a protected key", () => {
    expect(parseCommand("/config set telegram.botToken X").kind).toBe("denied");
    expect(parseCommand("/config set telegram.users [1] ").kind).toBe("denied");
    expect(parseCommand("/config set telegram.chats [1]").kind).toBe("denied");
    expect(parseCommand("/config set telegram.supergroupId -100").kind).toBe("denied");
  });

  it("allows /config set only on writable keys", () => {
    expect(WRITABLE_CONFIG_KEYS).toContain("defaults.effort");
    const p = parseCommand("/config set defaults.effort low");
    expect(p).toEqual({ kind: "ok", name: "config", argv: ["config", "set", "defaults.effort", "low"] });
  });

  it("requires key and value for /config set", () => {
    expect(parseCommand("/config set defaults.effort").kind).toBe("usage");
  });

  it("rejects unknown commands", () => {
    expect(parseCommand("/frobnicate").kind).toBe("unknown");
  });

  it("rejects non-slash text as unknown", () => {
    expect(parseCommand("hello there").kind).toBe("unknown");
  });

  it("returns a usage listing for /help", () => {
    const p = parseCommand("/help");
    expect(p.kind).toBe("usage");
    if (p.kind === "usage") {
      expect(p.message).toContain("/status");
      expect(p.message).toContain("/spawn");
    }
  });

  it("captures the rest of the line as the spawn task", () => {
    const p = parseCommand("/spawn brove fix the header bug");
    expect(p).toMatchObject({ kind: "ok", name: "spawn", argv: ["crew", "spawn", "brove", "fix the header bug"] });
  });

  it("requires a project and task for /spawn", () => {
    expect(parseCommand("/spawn").kind).toBe("usage");
    expect(parseCommand("/spawn brove").kind).toBe("usage");
  });

  it("/unmute <project> → telegram notify <project> on", () => {
    expect(parseCommand("/unmute squadrant")).toEqual({ kind: "ok", name: "unmute", argv: ["telegram", "notify", "squadrant", "on"] });
  });

  it("/mute <project> → telegram notify <project> off", () => {
    expect(parseCommand("/mute squadrant")).toEqual({ kind: "ok", name: "mute", argv: ["telegram", "notify", "squadrant", "off"] });
  });

  it("/mute with no project → usage", () => {
    expect(parseCommand("/mute")).toEqual({ kind: "usage", name: "mute", message: "usage: /mute <project>" });
  });

  // @botname suffix — Telegram appends this when a command is tapped from the / menu in groups
  it("strips @botname suffix from /status@squadrant_bot", () => {
    expect(parseCommand("/status@squadrant_bot")).toEqual({ kind: "ok", name: "status", argv: ["status"] });
  });

  it("strips @botname suffix from /mute@squadrant_bot squadrant", () => {
    expect(parseCommand("/mute@squadrant_bot squadrant")).toEqual({
      kind: "ok", name: "mute", argv: ["telegram", "notify", "squadrant", "off"],
    });
  });

  it("strips @botname suffix from /unmute@squadrant_bot squadrant", () => {
    expect(parseCommand("/unmute@squadrant_bot squadrant")).toEqual({
      kind: "ok", name: "unmute", argv: ["telegram", "notify", "squadrant", "on"],
    });
  });

  it("bare command (no @botname) still works identically", () => {
    expect(parseCommand("/status")).toEqual({ kind: "ok", name: "status", argv: ["status"] });
  });
});
