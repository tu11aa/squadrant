// src/control/__tests__/ensure-daemon-callsite.test.ts
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { daemonEntryPath } from "../launchd.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", "..", rel), "utf-8");

// Guard test: index.ts must call ensureDaemon so the daemon self-heals
// on every cockpit invocation (mirrors ensureRuntimeSynced philosophy).
it("index.ts wires ensureDaemon after ensureRuntimeSynced", () => {
  const idx = read("index.ts");
  expect(idx).toMatch(/ensureDaemon/);
  expect(idx.indexOf("ensureRuntimeSynced")).toBeLessThan(idx.indexOf("ensureDaemon"));
});

// Regression guard (PR #85, found in real-env testing — hermetic tests inject
// their own paths so could not catch it): the daemon entry must be resolved
// inside launchd.daemonEntryPath, NOT recomputed at call sites. A hardcoded
// ~/.config/cockpit/dist path crash-loops the agent with MODULE_NOT_FOUND
// because runtime-sync never mirrors compiled output there.
it("no call site recomputes the daemon entry path", () => {
  for (const f of ["index.ts", "commands/crew-control.ts"]) {
    const src = read(f);
    // ensureDaemon is called with no path argument (resolved internally)
    expect(src).toMatch(/ensureDaemon\(\)/);
    // and the buggy hardcoded path is absent
    expect(src).not.toMatch(/"\.config",\s*"cockpit",\s*"dist"/);
  }
});

it("daemonEntryPath resolves to a sibling control/cockpitd.js, never ~/.config/cockpit/dist", () => {
  const p = daemonEntryPath();
  expect(p.endsWith(`${join("control", "cockpitd.js")}`)).toBe(true);
  expect(p).not.toContain(join(".config", "cockpit", "dist"));
});
