// src/control/__tests__/ensure-daemon-callsite.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Guard test: index.ts must call ensureDaemon so the daemon self-heals
// on every cockpit invocation (mirrors ensureRuntimeSynced philosophy).
it("index.ts wires ensureDaemon after ensureRuntimeSynced", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const idx = readFileSync(join(here, "..", "..", "index.ts"), "utf-8");
  expect(idx).toMatch(/ensureDaemon/);
  expect(idx.indexOf("ensureRuntimeSynced")).toBeLessThan(idx.indexOf("ensureDaemon"));
});
