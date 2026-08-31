#!/usr/bin/env node
// Generates docs/generated/control-events.md: every ControlEvent variant vs its
// producers (emit sites) and consumers (state-machine case, reduce.ts allowlist,
// telegram formatter), plus registered LifecycleSource count vs CLAUDE.md's claim.
//
// `--check` regenerates the table in memory and exits non-zero if it differs
// from what's on disk, OR if a ControlEvent variant has zero shipped producers
// and is not in KNOWN_ZERO_PRODUCER below. That's what makes a new zombie event
// or doc drift fail `pnpm test` instead of sitting unnoticed.
//
// Plain Node, no dependencies. See docs/specs/2026-08-29-event-architecture-design.md §1.5, §11.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTROL_TYPES_FILE = join(ROOT, "packages/shared/src/types/control.ts");
const STATE_MACHINE_FILE = join(ROOT, "packages/core/src/state-machine.ts");
const REDUCE_FILE = join(ROOT, "packages/core/src/daemon/reduce.ts");
const TELEGRAM_FORMAT_FILE = join(ROOT, "packages/core/src/telegram/format.ts");
const SQUADRANTD_FILE = join(ROOT, "packages/cli/src/squadrantd.ts");
const CLAUDE_MD_FILE = join(ROOT, "CLAUDE.md");
const OUT_FILE = join(ROOT, "docs/generated/control-events.md");
const PACKAGES_DIR = join(ROOT, "packages");

// Variants verified (2026-08-29 event-architecture design, §1.5) to have a
// state-machine case, a reduce.ts allowlist entry, and (for task.idle) a
// telegram formatter — but zero shipped producers. Removing an entry here
// without giving it a real producer is a lie; adding one back is a real
// regression. Either way this list must be a deliberate edit, not silent.
const KNOWN_ZERO_PRODUCER = ["heartbeat", "task.idle", "task.reconcile-failed"];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walkSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "__tests__" || entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

function extractVariants(controlTypesText) {
  const variants = [];
  const re = /^\s*\|\s*\{\s*type:\s*"([^"]+)"/gm;
  let m;
  while ((m = re.exec(controlTypesText))) variants.push(m[1]);
  return variants;
}

// Producer = a line constructing `{ type: "<variant>" ... }` as an object
// literal (an emit site). Excludes the union definition itself and
// `Extract<ControlEvent, { type: "..." }>` type-level narrowing, which reads
// like construction but declares nothing.
function findProducers(files, variant) {
  const re = new RegExp(`type:\\s*["']${escapeRe(variant)}["']`);
  const hits = [];
  for (const file of files) {
    if (file === CONTROL_TYPES_FILE) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("Extract<")) continue;
      if (re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    }
  }
  return hits;
}

function hasCase(text, variant) {
  return new RegExp(`case\\s+["']${escapeRe(variant)}["']\\s*:`).test(text);
}

function extractKnownEventTypes(reduceText) {
  const m = reduceText.match(/KNOWN_EVENT_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error("KNOWN_EVENT_TYPES not found in reduce.ts");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

function extractLifecycleSources(squadrantdText) {
  const block = squadrantdText.match(/ctx\.lifecycleSources\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("ctx.lifecycleSources assignment not found in squadrantd.ts");
  const varNames = [...block[1].matchAll(/(\w+)/g)].map((x) => x[1]);
  return varNames.map((varName) => {
    const decl = squadrantdText.match(new RegExp(`const\\s+${escapeRe(varName)}\\s*=\\s*new\\s+(\\w+)\\(`));
    return decl ? decl[1] : varName;
  });
}

function extractClaudeMdClaim(claudeMdText) {
  const m = claudeMdText.match(/(\d+)\s+`LifecycleSource`\s+implementations/);
  return m ? Number(m[1]) : null;
}

function buildTable() {
  const controlTypesText = readFileSync(CONTROL_TYPES_FILE, "utf8");
  const stateMachineText = readFileSync(STATE_MACHINE_FILE, "utf8");
  const reduceText = readFileSync(REDUCE_FILE, "utf8");
  const telegramText = readFileSync(TELEGRAM_FORMAT_FILE, "utf8");
  const squadrantdText = readFileSync(SQUADRANTD_FILE, "utf8");
  const claudeMdText = existsSync(CLAUDE_MD_FILE) ? readFileSync(CLAUDE_MD_FILE, "utf8") : "";

  const variants = extractVariants(controlTypesText);
  const sourceFiles = walkSourceFiles(PACKAGES_DIR);
  const knownEventTypes = extractKnownEventTypes(reduceText);

  const rows = variants.map((variant) => {
    const producers = findProducers(sourceFiles, variant);
    const zombie = producers.length === 0;
    const allowedZombie = KNOWN_ZERO_PRODUCER.includes(variant);
    return {
      variant,
      producers,
      stateMachine: hasCase(stateMachineText, variant),
      reduceAllowlist: knownEventTypes.has(variant),
      telegramFormatter: hasCase(telegramText, variant),
      zombie,
      allowedZombie,
    };
  });

  const unauthorizedZombies = rows.filter((r) => r.zombie && !r.allowedZombie).map((r) => r.variant);
  const staleAllowlistEntries = KNOWN_ZERO_PRODUCER.filter(
    (v) => !rows.some((r) => r.variant === v && r.zombie),
  );

  const registeredSources = extractLifecycleSources(squadrantdText);
  const claudeMdClaim = extractClaudeMdClaim(claudeMdText);

  const lines = [];
  lines.push("<!-- GENERATED by scripts/control-event-table.mjs — do not hand-edit. -->");
  lines.push("<!-- Regenerate: node scripts/control-event-table.mjs -->");
  lines.push("");
  lines.push("# ControlEvent producer/consumer table");
  lines.push("");
  lines.push(
    "Every `ControlEvent` variant (`packages/shared/src/types/control.ts`) against its shipped " +
      "producers and consumers. ⚠ marks a variant with zero shipped producers — see " +
      "`docs/specs/2026-08-29-event-architecture-design.md` §1.5 / §11.",
  );
  lines.push("");
  lines.push("| Variant | Producers | state-machine.ts | reduce.ts allowlist | telegram formatter |");
  lines.push("|---|---|---|---|---|");
  for (const r of rows) {
    const variantCell = r.zombie ? `⚠ \`${r.variant}\`` : `\`${r.variant}\``;
    const producerCell = r.zombie ? "0 (known zombie)" : String(r.producers.length);
    lines.push(
      `| ${variantCell} | ${producerCell} | ${r.stateMachine ? "✓" : "—"} | ${
        r.reduceAllowlist ? "✓" : "—"
      } | ${r.telegramFormatter ? "✓" : "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Producer sites");
  lines.push("");
  for (const r of rows) {
    if (r.producers.length === 0) continue;
    lines.push(`- \`${r.variant}\``);
    for (const hit of r.producers) lines.push(`  - ${hit}`);
  }
  lines.push("");
  lines.push("## Known zero-producer variants (allowlisted)");
  lines.push("");
  if (KNOWN_ZERO_PRODUCER.length === 0) {
    lines.push("(none)");
  } else {
    for (const v of KNOWN_ZERO_PRODUCER) lines.push(`- \`${v}\``);
  }
  lines.push("");
  lines.push("## LifecycleSource implementations");
  lines.push("");
  lines.push(`Registered in \`packages/cli/src/squadrantd.ts\` (\`ctx.lifecycleSources\`): **${registeredSources.length}**`);
  lines.push("");
  for (const cls of registeredSources) lines.push(`- \`${cls}\``);
  lines.push("");
  lines.push(
    `CLAUDE.md claims: **${claudeMdClaim === null ? "not found" : claudeMdClaim}** ${
      claudeMdClaim === registeredSources.length ? "(matches ✓)" : "(⚠ DRIFT — does not match)"
    }`,
  );
  lines.push("");

  const content = lines.join("\n");
  return { content, unauthorizedZombies, staleAllowlistEntries, registeredSources, claudeMdClaim };
}

function main() {
  const check = process.argv.includes("--check");
  const { content, unauthorizedZombies, staleAllowlistEntries } = buildTable();

  let failed = false;

  if (unauthorizedZombies.length > 0) {
    console.error(
      `control-event-table: new zero-producer ControlEvent variant(s) not in KNOWN_ZERO_PRODUCER: ${unauthorizedZombies.join(", ")}`,
    );
    console.error("Either add a producer, or deliberately add the variant to KNOWN_ZERO_PRODUCER in scripts/control-event-table.mjs.");
    failed = true;
  }

  if (staleAllowlistEntries.length > 0) {
    console.error(
      `control-event-table: KNOWN_ZERO_PRODUCER lists variant(s) that now have a producer — remove from the allowlist: ${staleAllowlistEntries.join(", ")}`,
    );
    failed = true;
  }

  if (check) {
    const onDisk = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : null;
    if (onDisk !== content) {
      console.error(`control-event-table: ${OUT_FILE} is stale. Run: node scripts/control-event-table.mjs`);
      failed = true;
    }
    process.exit(failed ? 1 : 0);
  }

  writeFileSync(OUT_FILE, content);
  console.log(`control-event-table: wrote ${relative(ROOT, OUT_FILE)}`);
  process.exit(failed ? 1 : 0);
}

main();
