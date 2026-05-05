import { describe, it, expect } from "vitest";
import { classifyScreen } from "../status-classifier.js";

const opts = { lines: 50, excerptLines: 10 };

describe("classifyScreen", () => {
  it("returns offline when input is empty", () => {
    const out = classifyScreen("", opts);
    expect(out.state).toBe("offline");
    expect(out.excerpt).toBe("");
  });

  it("returns offline when input is whitespace", () => {
    const out = classifyScreen("   \n\n  \t\n", opts);
    expect(out.state).toBe("offline");
  });

  it("returns offline when 'session ended' appears", () => {
    const out = classifyScreen("Welcome\nuser: hi\nassistant: bye\nsession ended\n", opts);
    expect(out.state).toBe("offline");
  });

  it("returns offline when '[process exited' appears", () => {
    const out = classifyScreen("running command\n[process exited with code 0]\n", opts);
    expect(out.state).toBe("offline");
  });

  it("returns errored when '✗' appears in tail", () => {
    const out = classifyScreen("doing work\n✗ build failed\n", opts);
    expect(out.state).toBe("errored");
  });

  it("returns errored on FATAL marker", () => {
    const out = classifyScreen("starting up\nFATAL: cannot bind port\n", opts);
    expect(out.state).toBe("errored");
  });

  it("returns errored on panic", () => {
    const out = classifyScreen("processing\npanic: index out of range\n", opts);
    expect(out.state).toBe("errored");
  });

  it("returns blocked on 'blocked' word", () => {
    const out = classifyScreen("ok\ncaptain is blocked on review\n", opts);
    expect(out.state).toBe("blocked");
  });

  it("returns blocked on 'waiting for input'", () => {
    const out = classifyScreen("ok\nwaiting for input from user\n", opts);
    expect(out.state).toBe("blocked");
  });

  it("returns busy on Claude spinner ✻ Cogitating", () => {
    const out = classifyScreen("│ > running task\n✻ Cogitating… (3s)\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns busy on braille spinner", () => {
    const out = classifyScreen("│ > tests\n⠋ running tests\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns busy on 'Brewing'", () => {
    const out = classifyScreen("doing\nBrewing response (2s)\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns busy on 'Compiling'", () => {
    const out = classifyScreen("starting build\nCompiling project...\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns idle when prompt visible and no busy markers", () => {
    const out = classifyScreen([
      "Last task complete.",
      "│ Welcome to Claude Code",
      "│ > ",
    ].join("\n"), opts);
    expect(out.state).toBe("idle");
  });

  it("returns idle on bare shell prompt", () => {
    const out = classifyScreen("$ ls\nfile.ts\n$ ", opts);
    expect(out.state).toBe("idle");
  });

  it("priority: errored beats blocked", () => {
    const out = classifyScreen("blocked on input\n✗ also failed\n", opts);
    expect(out.state).toBe("errored");
  });

  it("priority: blocked beats busy", () => {
    const out = classifyScreen("Compiling\nblocked on user response\n", opts);
    expect(out.state).toBe("blocked");
  });

  it("excerpt is last N non-empty lines joined", () => {
    const screen = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const out = classifyScreen(screen, { lines: 50, excerptLines: 5 });
    expect(out.excerpt.split("\n")).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
  });

  it("excerpt skips blank lines", () => {
    const screen = "alpha\n\n\nbeta\n\ngamma\n";
    const out = classifyScreen(screen, { lines: 50, excerptLines: 3 });
    expect(out.excerpt).toBe("alpha\nbeta\ngamma");
  });

  it("only inspects last `lines` lines for classification", () => {
    const oldError = "✗ old failure";
    const filler = Array.from({ length: 200 }, () => "neutral line").join("\n");
    const tail = "│ > ";
    const screen = [oldError, filler, tail].join("\n");
    const out = classifyScreen(screen, { lines: 5, excerptLines: 3 });
    expect(out.state).toBe("idle");
  });
});
