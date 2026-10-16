import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@squadrant/shared";
import { addTrait, reviewQueue, type ProfileCtx } from "@squadrant/core";
import { profileCommand, formatQueue, formatList, showTrait } from "../profile.js";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) process.env[k] = v;

let ctx: ProfileCtx;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pcli-"));
  ctx = { cfg: getDefaultConfig(), env: { SQUADRANT_USER_KB_DIR: path.join(base, "_user") }, cwd: base, audit: { dir: path.join(base, "audit") } };
});
const input = (summary: string) => `---\nsummary: ${JSON.stringify(summary)}\n---\nWhy: x.\n`;

describe("squadrant profile CLI", () => {
  it("has add/review/list/show, and review has no bulk-keep flag", () => {
    expect(profileCommand.commands.map((c) => c.name()).sort()).toEqual(["add", "list", "review", "show"]);
    const review = profileCommand.commands.find((c) => c.name() === "review")!;
    const flags = review.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(["--keep", "--drop", "--reason", "--edit", "--json"]));
    for (const bulk of ["--all", "--keep-all", "--yes"]) expect(flags).not.toContain(bulk);
  });
  it("formatQueue shows ids, summaries and source dirs, and tells the agent to show every summary", () => {
    addTrait(ctx, { text: input("Guess one."), kind: "preference", id: "g1" });
    const text = formatQueue(reviewQueue(ctx), ["/n/-Users-tu/memory/a.md"]);
    expect(text).toMatch(/Show the operator EVERY summary/);
    expect(text).toContain('1. [new] prof.g1 (preference): "Guess one."');
    expect(text).toContain("/n/-Users-tu/memory/a.md");
    expect(formatQueue([])).toBe("Profile review queue is empty.");
  });
  it("formatList prints both view sizes; --all adds proposals; show prints one trait", () => {
    addTrait(ctx, { text: input("Live one."), kind: "preference", id: "l1", apply: true });
    addTrait(ctx, { text: input("Guess one."), kind: "preference", id: "g1" });
    expect(formatList(ctx, false)).toMatch(/captain 9\/3,000 · crew 9\/3,000/);
    expect(formatList(ctx, false)).not.toContain("prof.g1");
    expect(formatList(ctx, true)).toContain("prof.g1");
    expect(showTrait(ctx, "l1")).toContain("summary: Live one.");
    expect(showTrait(ctx, "nope")).toBeNull();
  });
});
