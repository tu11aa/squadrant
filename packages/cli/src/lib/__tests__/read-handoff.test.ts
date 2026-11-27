import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #1155: read-handoff.sh is a thin shim over `squadrant handoff read`.
// Reader behavior is covered in handoff-read.test.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../../../scripts/read-handoff.sh");

describe("read-handoff.sh shim", () => {
  it("execs `squadrant handoff read <basename> [flags]`", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-shim-"));
    try {
      const bin = path.join(tmp, "squadrant");
      fs.writeFileSync(bin, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
      const env = { ...process.env, PATH: `${tmp}:${process.env.PATH}` };
      const out = execFileSync("bash", [SCRIPT, "/some/hub/spokes/myproj", "--keep"], { encoding: "utf8", env });
      expect(out.trim()).toBe("handoff read myproj --keep");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
