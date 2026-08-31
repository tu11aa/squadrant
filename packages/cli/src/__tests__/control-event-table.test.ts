// Wires scripts/control-event-table.mjs --check into `pnpm test` so a new
// zero-producer ControlEvent variant, a stale docs/generated/control-events.md,
// or a KNOWN_ZERO_PRODUCER entry that has grown a producer all fail the build
// instead of sitting unnoticed. See docs/specs/2026-08-29-event-architecture-design.md §11.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/control-event-table.mjs");

describe("control-event-table --check", () => {
  it("docs/generated/control-events.md is up to date and has no unauthorized zombie events", () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, "--check"], { cwd: REPO_ROOT, stdio: "pipe" })).not.toThrow();
  });
});
