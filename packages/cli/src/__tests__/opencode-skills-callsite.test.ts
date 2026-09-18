// #791: squadrant must project its skills into opencode's global skills dir
// (parity with claude's --plugin-dir) and reconcile them on install/update.
// These are call-site guards: the sync must fire on every squadrant invocation
// and on daemon boot, so a shipped-skill change can never leave the projection
// stale. The projection/prune behavior itself is covered by the
// opencode-skills unit tests in @squadrant/agents.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf-8");

it("index.ts syncs opencode skills after ensureRuntimeSynced (self-heal on every invocation)", () => {
  const idx = read("index.ts");
  expect(idx).toMatch(/syncShippedOpencodeSkills/);
  expect(idx.indexOf("ensureRuntimeSynced")).toBeLessThan(idx.indexOf("syncShippedOpencodeSkills"));
});

it("squadrantd.ts refreshes opencode skills on daemon boot", () => {
  const daemon = read("squadrantd.ts");
  expect(daemon).toMatch(/syncShippedOpencodeSkills\(\{\s*pkgRoot:/);
});
