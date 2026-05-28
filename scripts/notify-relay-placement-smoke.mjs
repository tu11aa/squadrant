#!/usr/bin/env node
// Live E2E for #117: spawnInjector("hidden") must NOT create a split-pane and
// must NOT steal focus. Drives the real built cmux driver against a throwaway
// cmux workspace, then inspects `cmux tree` to assert:
//   1. the workspace has exactly ONE pane (a split would create a second)
//   2. the relay surface exists as a background tab in that pane
//   3. the surface selected before spawn is still [selected] afterward
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const cmux = (args) => execFileSync(CMUX, args, { encoding: "utf-8" }).trim();
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const { createCmuxDriver } = await import(
  "file://" + join(__dirname, "..", "dist", "runtimes", "cmux.js")
);

let failures = 0;
const assert = (cond, label) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

const out = cmux(["new-workspace", "--cwd", "/tmp", "--command", "bash"]);
const ws = out.match(/workspace:\d+/)?.[0];
cmux(["rename-workspace", "--workspace", ws, "zz-117-smoke"]);
const driver = createCmuxDriver();

try {
  const treeBefore = cmux(["tree", "--workspace", ws]);
  const capSurface = treeBefore.match(/(surface:\d+)\s+\[terminal\][^\n]*\[selected\]/)?.[1];
  console.log(`workspace=${ws} captain surface=${capSurface}`);

  const pane = await driver.spawnInjector({
    captainWorkspace: { id: ws, name: "zz-117-smoke", status: "running" },
    command: "echo notify-relay-stub; sleep 30",
    title: "✉ notify-relay",
    placement: "hidden",
  });
  console.log(`spawnInjector returned ${pane.surfaceId}`);

  const tree = cmux(["tree", "--workspace", ws]);
  console.log("--- tree after spawnInjector(hidden) ---\n" + tree);

  const paneCount = (tree.match(/^\s*[├└]?[─ ]*pane\s+pane:\d+/gm) || []).length;
  assert(paneCount === 1, `exactly ONE pane — no split (got ${paneCount})`);

  const surfaces = (tree.match(/surface:\d+/g) || []);
  assert(surfaces.includes(pane.surfaceId), `relay surface ${pane.surfaceId} present as a tab`);

  const selected = tree.match(/(surface:\d+)\s+\[terminal\][^\n]*\[selected\]/)?.[1];
  assert(selected === capSurface, `captain surface ${capSurface} still [selected] (relay did NOT steal focus; got ${selected})`);

  console.log(`\n${failures === 0 ? "✔ PLACEMENT SMOKE PASSED" : `✗ ${failures} FAILURES`}`);
} finally {
  cmux(["close-workspace", "--workspace", ws]);
  process.exit(failures > 0 ? 1 : 0);
}
