// #1015: the live-ledger block re-injected after a captain compact.
import { describe, it, expect } from "vitest";
import { renderLiveLedger, taskSummary } from "../compact-ledger.js";
import type { MailboxEntry } from "@squadrant/core";

const mail = (seq: number, message: string): MailboxEntry => ({ seq, ts: "t", kind: "task.done", name: "c1", message });

describe("renderLiveLedger", () => {
  it("is empty when there is nothing live and nothing queued", () => {
    expect(renderLiveLedger([], [])).toBe("");
  });

  it("renders one line per crew with the question verbatim, PR stage, and the mailbox backlog", () => {
    const out = renderLiveLedger(
      [
        { name: "noise", state: "blocked", task: "t", question: "Rebase onto develop, or merge?\nSecond line" },
        { name: "ledger", state: "done", task: "t", reviewStage: "pr-open", branch: "crew/ledger", prUrl: "https://github.com/x/y/pull/9", reviewNote: "tests green" },
      ],
      [mail(12, "CREW DONE c1 — shipped"), mail(13, "CREW BLOCKED c2")],
    );
    expect(out).toContain('- noise [blocked] | t | question: "Rebase onto develop, or merge?\nSecond line"');
    expect(out).toContain("- ledger [awaiting human review] | t | branch crew/ledger | PR https://github.com/x/y/pull/9 | review note: tests green");
    expect(out).toContain("Undelivered mailbox: 2 message(s)");
    expect(out).toContain("#12 task.done (c1): CREW DONE c1 — shipped");
  });

  it("gives every crew a task summary and branch", () => {
    const out = renderLiveLedger([{ name: "noise", state: "working", task: "## Objective\nFix #1017 cut crew IDLE noise in the captain pane\nmore", branch: "crew/noise" }], []);
    expect(out).toContain("- noise [working] | Fix #1017 cut crew IDLE noise in the captain pane | branch crew/noise");
  });

  it("summary skips headings, strips bullets and clips to ~120 chars", () => {
    expect(taskSummary("## Objective\n- Implement the thing")).toBe("Implement the thing");
    expect(taskSummary("x".repeat(300)).length).toBe(120);
    expect(taskSummary("")).toBe("");
  });

  it("labels a done crew with an open tab as awaiting captain review", () => {
    const out = renderLiveLedger([{ name: "w", state: "done", task: "ship it", tabOpen: true }], []);
    expect(out).toContain("- w [done: awaiting captain review] | ship it");
  });

  it("bounds its size and says it truncated", () => {
    const crews = Array.from({ length: 200 }, (_, i) => ({ name: `crew-${i}`, state: "working", task: "t", question: "q".repeat(50) }));
    const out = renderLiveLedger(crews, []);
    expect(out.length).toBeLessThan(4300);
    expect(out).toMatch(/\[ledger truncated at 4000 chars/);
  });

  it("previews only the first few backlog entries", () => {
    const out = renderLiveLedger([], Array.from({ length: 9 }, (_, i) => mail(i + 1, `m${i}`)));
    expect(out).toContain("…and 4 more");
  });
});
