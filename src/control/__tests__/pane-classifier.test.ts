import { describe, it, expect } from "vitest";
import { classifyPaneTail } from "../interactive/pane-classifier.js";

// A representative Claude permission-prompt pane, with the box-drawing TUI
// chrome that wraps it (the input box + the "accept edits on" status line).
const CLAUDE_APPROVAL = [
  "● I'll create the file now.",
  "",
  "╭──────────────────────────────────────────────────────╮",
  "│ Do you want to create newfile.txt?                     │",
  "│                                                        │",
  "│ ❯ 1. Yes                                               │",
  "│   2. Yes, allow all edits during this session          │",
  "│   3. No, and tell Claude what to do differently        │",
  "╰──────────────────────────────────────────────────────╯",
  "╭──────────────────────────────────────────────────────╮",
  "│ >                                                      │",
  "╰──────────────────────────────────────────────────────╯",
  "  accept edits on (shift+tab to cycle)                    ",
].join("\n");

// A normal working pane: assistant output and the input box, no prompt/options.
const WORKING_PANE = [
  "● Reading src/index.ts...",
  "● The function looks correct; running the tests next.",
  "╭──────────────────────────────────────────────────────╮",
  "│ >                                                      │",
  "╰──────────────────────────────────────────────────────╯",
  "  accept edits on (shift+tab to cycle)                    ",
].join("\n");

// A pane whose agent output ends in a direct question (mainly the opencode
// path — opencode has no Stop hook so the daemon never sees a turn-end block).
const QUESTION_PANE = [
  "I looked at both options for the cache layer.",
  "Should I use Redis or an in-memory LRU for this?",
  "╭──────────────────────────────────────────────────────╮",
  "│ >                                                      │",
  "╰──────────────────────────────────────────────────────╯",
].join("\n");

describe("classifyPaneTail", () => {
  it("classifies a Claude permission dialog as approval with the prompt text", () => {
    const r = classifyPaneTail(CLAUDE_APPROVAL);
    expect(r).toEqual({ kind: "approval", text: "Do you want to create newfile.txt?" });
  });

  it("returns null for a normal working pane (no prompt, no options)", () => {
    expect(classifyPaneTail(WORKING_PANE)).toBeNull();
  });

  it("classifies a trailing-question pane as question with the question text", () => {
    const r = classifyPaneTail(QUESTION_PANE);
    expect(r).toEqual({ kind: "question", text: "Should I use Redis or an in-memory LRU for this?" });
  });

  it("returns null for chrome-only or empty input", () => {
    expect(classifyPaneTail("")).toBeNull();
    const chromeOnly = [
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
      "  accept edits on             ",
    ].join("\n");
    expect(classifyPaneTail(chromeOnly)).toBeNull();
  });

  it("classifies a Claude API 529 overloaded banner as error", () => {
    const tail = [
      "● Patching the reducer next.",
      '⎿ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    const r = classifyPaneTail(tail);
    expect(r?.kind).toBe("error");
    expect(r?.text).toContain("API Error: 529");
  });

  it("classifies an HTTP 503 service-unavailable banner as error", () => {
    const tail = [
      "● Calling the model...",
      "  503 Service Unavailable",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    expect(classifyPaneTail(tail)?.kind).toBe("error");
  });

  it("classifies a retry-exhaustion banner as error", () => {
    const tail = [
      "  Request failed after maximum retries",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    expect(classifyPaneTail(tail)?.kind).toBe("error");
  });

  it("does not misfire error on prose that merely mentions errors", () => {
    const tail = [
      "● I added error handling for the 500 most common cases.",
      "● The tests cover the unavailable-network path too.",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    expect(classifyPaneTail(tail)).toBeNull();
  });

  it("prefers a trailing question over error so a recoverable wait is never mis-failed", () => {
    // A genuine question that happens to mention an error term must stay a
    // (recoverable) question, not become a terminal failure.
    const tail = [
      "The last call hit an API Error earlier.",
      "Should I retry the request now?",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    expect(classifyPaneTail(tail)).toEqual({
      kind: "question",
      text: "Should I retry the request now?",
    });
  });

  it("does not misfire approval on a numbered list that lacks a Yes/No block", () => {
    const numberedList = [
      "Here is the plan:",
      "1. Read the config",
      "2. Patch the reducer",
      "3. Run the tests",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    expect(classifyPaneTail(numberedList)).toBeNull();
  });
});
