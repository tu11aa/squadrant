// src/control/__tests__/ensure-daemon-callsite.test.ts
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { daemonEntryPath } from "@squadrant/core";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf-8");

// Guard test: index.ts must call ensureDaemon so the daemon self-heals
// on every squadrant invocation (mirrors ensureRuntimeSynced philosophy).
it("index.ts wires ensureDaemon after ensureRuntimeSynced", () => {
  const idx = read("index.ts");
  expect(idx).toMatch(/ensureDaemon/);
  expect(idx.indexOf("ensureRuntimeSynced")).toBeLessThan(idx.indexOf("ensureDaemon"));
});

// Regression guard (PR #85, found in real-env testing — hermetic tests inject
// their own paths so could not catch it): the daemon entry must be resolved
// inside launchd.daemonEntryPath, NOT recomputed at call sites. A hardcoded
// ~/.config/squadrant/dist path crash-loops the agent with MODULE_NOT_FOUND
// because runtime-sync never mirrors compiled output there.
it("no call site recomputes the daemon entry path", () => {
  // crew-control.ts's on-socket-failure fallback call is deliberately
  // unchanged (#636): a socket-RPC retry is never operator-initiated, so no
  // allowlist applies here — it stays gated to the captain marker alone.
  const crewControlSrc = read("commands/crew-control.ts");
  expect(crewControlSrc).toMatch(/ensureDaemon\(\)/);
  expect(crewControlSrc).not.toMatch(/"\.config",\s*"squadrant",\s*"dist"/);

  // index.ts (#636): nodeBin is still passed as `undefined` (resolved
  // internally by ensureDaemon, never recomputed here) — only the second arg
  // changed, to carry the operatorInitiated flag computed from real argv.
  const idxSrc = read("index.ts");
  expect(idxSrc).toMatch(/ensureDaemon\(undefined,\s*\{\s*operatorInitiated/);
  expect(idxSrc).not.toMatch(/"\.config",\s*"squadrant",\s*"dist"/);
});

// #636: index.ts must resolve operatorInitiated from the actual subcommand
// the human typed (argv[2]), not from a hardcoded true/false or an env var —
// otherwise the allowlist gate is meaningless.
it("index.ts derives operatorInitiated from process.argv[2] via isOperatorInitiatedCommand", () => {
  const idx = read("index.ts");
  expect(idx).toMatch(/isOperatorInitiatedCommand\(process\.argv\[2\]\)/);
});

// #259: in vitest context import.meta.url resolves to the src/ tree, so
// daemonEntryPath() resolves to src/control/squadrantd.js which doesn't exist.
// The guard must throw so ensureDaemon() catches it and never writes a bad plist.
it("daemonEntryPath throws when compiled entry not found (src-tree guard, #259)", () => {
  expect(() => daemonEntryPath()).toThrow(/compiled entry not found|run.*build/i);
});

// #752: read-only `crew` subcommands (list/read/tasks) must never reach
// ensureDaemon at all — that's what keeps them from ever printing the
// #670/#752 foreign-install banner, even inside a captain session where
// SQUADRANT_ROLE=captain would otherwise authorize the mutating path.
it("index.ts skips ensureDaemon for read-only crew subcommands via isReadOnlyCrewCommand", () => {
  const idx = read("index.ts");
  expect(idx).toMatch(/!isReadOnlyCrewCommand\(process\.argv\)/);
  expect(idx.indexOf("isReadOnlyCrewCommand")).toBeLessThan(idx.indexOf("ensureDaemon(undefined"));
});
