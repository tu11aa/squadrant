// profile.ts — `squadrant profile add|review|list|show`: the operator profile (_user KB, #982 S1).
// Spec: docs/specs/2026-10-15-user-profile-design.md §4. The core lives in @squadrant/core (profile-write.ts).
import fs from "node:fs";
import readline from "node:readline/promises";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, userKbDir } from "@squadrant/shared";
import {
  addTrait, reviewQueue, keepItems, dropItems, editItem, checkProfile, loadProfile, viewSizes, coveredNativeFiles,
  PROFILE_CORE_CAP, type ProfileCtx, type ProfileWriteResult, type QueueItem, type TraitKind, type TraitAudience, type TraitTier,
} from "@squadrant/core";

const readInput = (file?: string) => (file === undefined ? undefined : fs.readFileSync(file === "-" ? 0 : file, "utf8"));
const ids = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith("prof.") ? s : `prof.${s}`));

function ctxFrom(session?: string): ProfileCtx {
  return { cfg: loadConfig(), env: process.env, cwd: process.cwd(), ...(session ? { session } : {}) };
}

/** Print results; true when every item succeeded. */
function report(results: ProfileWriteResult[]): boolean {
  for (const r of results) {
    if (r.ok) console.log(r.line);
    else console.error(chalk.red(`${r.id}: ${r.error}`));
    for (const w of r.warnings) console.error(chalk.yellow(w));
  }
  return results.every((r) => r.ok);
}

const indent = (text: string, n: number) => text.trim().split("\n").slice(0, n).map((l) => `     ${l}`).join("\n");

/** The review queue as text for the agent. Numbers are for display; every action takes ids. */
export function formatQueue(queue: QueueItem[], covered: string[] = []): string {
  if (!queue.length && !covered.length) return "Profile review queue is empty.";
  const lines = [
    `Profile review queue (${queue.length}). Show the operator EVERY summary below before keeping anything; act by id, one item at a time (no bulk keep).`,
    ...queue.flatMap((q, i) => [
      `${i + 1}. [${q.type}] ${q.id} (${q.kind})${q.updates ? ` updates ${q.updates} (summary kept)` : ""}: "${q.summary}"`,
      ...(q.sourceDirs.length ? [`     from: ${q.sourceDirs.join(", ")}`] : []),
      ...(q.body.trim() ? [indent(q.body, 6)] : []),
    ]),
    "Apply: squadrant profile review --keep <id>[,<id>] | --drop <id>[,<id>] --reason \"<why>\" | --edit <id> --file -",
  ];
  if (covered.length) {
    lines.push("", "Native Claude memory files already covered by a kept trait (delete them yourself if you want; squadrant never does):",
      ...covered.map((f) => `  ${f}`));
  }
  return lines.join("\n");
}

export function formatList(ctx: ProfileCtx, all: boolean): string {
  const p = loadProfile(userKbDir(ctx.cfg, ctx.env));
  const s = viewSizes(p.active);
  const line = (t: { id: string; summary: string; kind: string; audience: string; tier: string; confirmed: boolean }) =>
    `  [${t.id}] ${t.summary} (${t.kind}, ${t.audience}, ${t.tier}${t.confirmed ? "" : ", unconfirmed"})`;
  const out = [`Core profile: captain ${s.captain.toLocaleString("en-US")}/${PROFILE_CORE_CAP.toLocaleString("en-US")} · crew ${s.crew.toLocaleString("en-US")}/${PROFILE_CORE_CAP.toLocaleString("en-US")} chars`,
    `Active (${p.active.length}):`, ...p.active.map(line)];
  if (all) out.push(`Proposed (${p.proposed.length}):`, ...p.proposed.map(line), `Archived (${p.archived.length}):`, ...p.archived.map(line));
  if (p.errors.length) out.push(chalk.yellow(`${p.errors.length} invalid file(s) skipped: squadrant profile list --check`));
  return out.join("\n");
}

export function showTrait(ctx: ProfileCtx, id: string): string | null {
  const p = loadProfile(userKbDir(ctx.cfg, ctx.env));
  const want = id.startsWith("prof.") ? id : `prof.${id}`;
  const t = [...p.active, ...p.proposed, ...p.archived].find((x) => x.id === want);
  return t ? fs.readFileSync(t.file, "utf8") : null;
}

async function interactiveReview(ctx: ProfileCtx): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const q of reviewQueue(ctx)) {
      console.log(formatQueue([q]).split("\n").slice(1, -1).join("\n"));
      const a = (await rl.question("(k)eep / (d)rop / (e)dit / (n)ext? ")).trim().toLowerCase();
      if (a === "k") report(keepItems(ctx, [q.id]));
      else if (a === "d") report(dropItems(ctx, [q.id], await rl.question("reason: ")));
      else if (a === "e") {
        const summary = await rl.question(`new summary [${q.summary}]: `);
        report([editItem(ctx, q.id, "", summary.trim() ? { summary: summary.trim() } : {})]);
      }
    }
  } finally { rl.close(); }
}

export const profileCommand = new Command("profile")
  .description("Operator profile (_user KB): how the operator works, injected into every session of every agent (#982)");

profileCommand
  .command("add")
  .description("Record a trait. --apply = live (correction: unconfirmed, always applies); without it = a proposal for review")
  .requiredOption("--kind <kind>", "preference | correction | procedure")
  .option("--apply", "go live now (refused in crew sessions: lands in _proposed/)")
  .option("--file <path>", "frontmatter + body from a file, '-' = stdin")
  .option("--summary <text>", "the one-line instruction that is injected (≤140 chars)")
  .option("--audience <a>", "all | captain | crew")
  .option("--tier <t>", "core | situational")
  .option("--id <slug>", "trait slug (default: from the summary)")
  .option("--session <id>", "session id for the commit trailer and source")
  .action((o: { kind: TraitKind; apply?: boolean; file?: string; summary?: string; audience?: TraitAudience; tier?: TraitTier; id?: string; session?: string }) => {
    const ok = report([addTrait(ctxFrom(o.session), { ...o, text: readInput(o.file) })]);
    process.exit(ok ? 0 : 1);
  });

profileCommand
  .command("review")
  .description("Review proposals and unconfirmed corrections, by id (no bulk keep). No flags on a TTY = interactive walk-through")
  .option("--json", "print the queue as JSON")
  .option("--keep <ids>", "keep these ids (comma-separated)")
  .option("--drop <ids>", "drop these ids (comma-separated); needs --reason")
  .option("--reason <text>", "why they are dropped (e.g. \"route: saitex rules\")")
  .option("--edit <id>", "replace fields/body from --file, then keep")
  .option("--file <path>", "for --edit: frontmatter + body, '-' = stdin")
  .option("--summary <text>", "for --edit: new summary")
  .action(async (o: { json?: boolean; keep?: string; drop?: string; reason?: string; edit?: string; file?: string; summary?: string }) => {
    const ctx = ctxFrom();
    let ok = true;
    if (o.keep) ok = report(keepItems(ctx, ids(o.keep))) && ok;
    if (o.drop) ok = report(dropItems(ctx, ids(o.drop), o.reason ?? "")) && ok;
    if (o.edit) ok = report([editItem(ctx, ids(o.edit)[0], readInput(o.file) ?? "", o.summary ? { summary: o.summary } : {})]) && ok;
    if (!o.keep && !o.drop && !o.edit) {
      const queue = reviewQueue(ctx);
      const covered = coveredNativeFiles(ctx.cfg, ctx.env);
      if (o.json) console.log(JSON.stringify({ queue, coveredNativeFiles: covered }, null, 2));
      else if (process.stdin.isTTY && process.stdout.isTTY && queue.length) await interactiveReview(ctx);
      else console.log(formatQueue(queue, covered));
    }
    process.exit(ok ? 0 : 1);
  });

profileCommand
  .command("list")
  .description("Active traits and the size of both audience views")
  .option("--all", "also list proposed and archived traits")
  .option("--check", "report invalid and uncommitted trait files")
  .option("--fix", "with --check: commit the uncommitted valid files")
  .action((o: { all?: boolean; check?: boolean; fix?: boolean }) => {
    const ctx = ctxFrom();
    if (!o.check) { console.log(formatList(ctx, !!o.all)); return; }
    try {
      const r = checkProfile(ctx, !!o.fix);
      for (const p of r.problems) console.log(chalk.red(`invalid: ${p}`));
      for (const u of r.uncommitted.filter((x) => !r.fixed.includes(x))) console.log(chalk.yellow(`uncommitted: ${u}`));
      for (const f of r.fixed) console.log(chalk.green(`committed: ${f}`));
      for (const w of r.warnings) console.error(chalk.yellow(w));
      if (!r.problems.length && !r.uncommitted.length) console.log("profile ok");
      process.exit(r.problems.length ? 1 : 0);
    } catch (err) { console.error(chalk.red((err as Error).message)); process.exit(1); }
  });

profileCommand
  .command("show <id>")
  .description("One trait in full (frontmatter + body)")
  .action((id: string) => {
    const text = showTrait(ctxFrom(), id);
    if (text === null) { console.error(chalk.red(`no trait ${id}`)); process.exit(1); }
    console.log(text);
  });
