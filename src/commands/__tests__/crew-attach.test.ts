import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  formatTurnHeader,
  formatTurnFooter,
  formatStatus,
  formatApproval,
  formatDoneFollowup,
  formatGatePromoted,
} from "../crew-attach.js";

describe("crew-attach formatters", () => {
  it("stripAnsi removes color codes but preserves text", () => {
    const colored = formatTurnHeader(1);
    const plain = stripAnsi(colored);
    expect(plain).toContain("codex");
    expect(plain).toContain("turn 1");
    expect(plain).not.toMatch(/\x1b\[/);
  });

  it("formatTurnHeader frames with rounded box-drawing chars", () => {
    const plain = stripAnsi(formatTurnHeader(3, 40));
    expect(plain.startsWith("╭─")).toBe(true);
    expect(plain.endsWith("╮")).toBe(true);
    expect(plain).toContain("turn 3");
  });

  it("formatTurnFooter shows elapsed seconds and closes box", () => {
    const plain = stripAnsi(formatTurnFooter(3200, 40));
    expect(plain.startsWith("╰─")).toBe(true);
    expect(plain.endsWith("╯")).toBe(true);
    expect(plain).toContain("3.2s");
  });

  it("formatStatus reports state, turn, and elapsed", () => {
    const plain = stripAnsi(formatStatus("working", 2, 1500));
    expect(plain).toContain("state=working");
    expect(plain).toContain("turn=2");
    expect(plain).toContain("elapsed=1.5s");
  });

  it("formatApproval includes kind and question", () => {
    const plain = stripAnsi(formatApproval("exec", "Run rm -rf?"));
    expect(plain).toContain("[approval] exec");
    expect(plain).toContain("Run rm -rf?");
  });

  it("dim helpers contain expected text", () => {
    expect(stripAnsi(formatDoneFollowup())).toContain("done — type a follow-up");
    expect(stripAnsi(formatGatePromoted("g-123"))).toContain("g-123");
  });
});
