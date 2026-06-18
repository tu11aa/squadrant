# Multi-Agent Support Implementation Plan

> **✅ Shipped** (multi-agent support (driver model in packages/), 2026-04-08). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cockpit agent-agnostic via a thin driver layer so any CLI agent (Claude, Codex, Gemini, Aider) can fill any role (command, captain, crew, reactor, exploration).

**Architecture:** Each agent gets a driver file (~40-60 lines) implementing `probe()`, `buildCommand()`, `parseOutput()`, `stop()`. A capability registry probes agents on startup and routes roles based on required/preferred capabilities. Config changes from `models: {crew: "sonnet"}` to `roles: {crew: {agent: "claude", model: "sonnet"}}` with backward compatibility.

**Tech Stack:** TypeScript, Node.js, Vitest (testing), Bash (spawn-workspace.sh)

**Spec:** `docs/specs/2026-04-08-multi-agent-support-design.md`

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/drivers/types.ts` | Create | AgentDriver interface, AgentCapability, SpawnOptions, AgentResult, AgentProbeResult types |
| `src/drivers/claude.ts` | Create | Claude Code driver — extracted from `buildClaudeCmd()` in launch.ts |
| `src/drivers/codex.ts` | Create | OpenAI Codex CLI driver |
| `src/drivers/gemini.ts` | Create | Google Gemini CLI driver |
| `src/drivers/aider.ts` | Create | Aider driver |
| `src/drivers/registry.ts` | Create | CapabilityRegistry — probes agents, resolves role→agent, validates capabilities |
| `src/drivers/index.ts` | Create | Re-exports all drivers + registry |
| `src/config.ts` | Modify | Add `AgentConfig`, `RoleConfig`, `agents` + `roles` fields, backward-compat migration |
| `src/commands/launch.ts` | Modify | Replace `buildClaudeCmd()` with `registry.getDriver(agent).buildCommand()` |
| `src/commands/doctor.ts` | Modify | Add agent probe section — show installed agents + capabilities |
| `src/commands/init.ts` | Modify | Deploy generic role templates alongside `.claude.md` ones |
| `scripts/spawn-workspace.sh` | Modify | Read agent from config, build command via agent-specific logic |
| `orchestrator/captain.claude.md` | Rename | From `captain.CLAUDE.md` |
| `orchestrator/captain.generic.md` | Create | Generic captain template — cmux + status files, no Agent Teams |
| `orchestrator/crew.claude.md` | Rename | From `crew.CLAUDE.md` |
| `orchestrator/crew.generic.md` | Create | Generic crew template — read task, work, commit, write status |
| `orchestrator/command.claude.md` | Rename | From `command.CLAUDE.md` |
| `orchestrator/reactor.claude.md` | Rename | From `reactor.CLAUDE.md` |
| `orchestrator/learnings.claude.md` | Rename | From `learnings.CLAUDE.md` |
| `src/drivers/__tests__/registry.test.ts` | Create | Tests for capability registry |
| `src/drivers/__tests__/claude.test.ts` | Create | Tests for Claude driver |
| `src/config.test.ts` | Modify | Add tests for new config types + backward compat migration |

---

### Task 1: Driver Interface & Types

**Files:**
- Create: `src/drivers/types.ts`
- Test: `src/drivers/__tests__/types.test.ts`

- [ ] **Step 1: Create the types file with all driver interfaces**

```typescript
// src/drivers/types.ts
export type AgentCapability =
  | "teams"
  | "json_output"
  | "sandbox"
  | "model_routing"
  | "skills"
  | "auto_approve"
  | "streaming"
  | "prompt_file";

export type Role = "command" | "captain" | "crew" | "reactor" | "exploration";

export interface AgentProbeResult {
  installed: boolean;
  version: string;
  capabilities: AgentCapability[];
}

export interface SpawnOptions {
  prompt: string;
  workdir: string;
  role: Role;
  model?: string;
  autoApprove?: boolean;
  jsonOutput?: boolean;
  promptFile?: string;
}

export interface AgentResult {
  status: "success" | "error" | "timeout";
  output: string;
  filesChanged?: string[];
}

export interface AgentDriver {
  name: string;
  templateSuffix: string; // "claude", "generic", etc. — used to find role templates

  probe(): Promise<AgentProbeResult>;
  buildCommand(opts: SpawnOptions): string;
  parseOutput(raw: string): AgentResult;
  stop(pid: number): Promise<void>;
}

export interface RoleRequirements {
  required: AgentCapability[];
  preferred: AgentCapability[];
}

export const ROLE_REQUIREMENTS: Record<Role, RoleRequirements> = {
  command:     { required: ["auto_approve"], preferred: ["teams", "json_output"] },
  captain:     { required: ["auto_approve"], preferred: ["teams", "model_routing", "skills"] },
  crew:        { required: ["auto_approve"], preferred: ["json_output", "sandbox"] },
  reactor:     { required: ["auto_approve", "json_output"], preferred: [] },
  exploration: { required: ["auto_approve"], preferred: [] },
};
```

- [ ] **Step 2: Write a type-check test**

```typescript
// src/drivers/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import { ROLE_REQUIREMENTS, type AgentDriver, type AgentCapability } from "../types.js";

describe("driver types", () => {
  it("defines requirements for all roles", () => {
    const roles = ["command", "captain", "crew", "reactor", "exploration"] as const;
    for (const role of roles) {
      expect(ROLE_REQUIREMENTS[role]).toBeDefined();
      expect(ROLE_REQUIREMENTS[role].required).toBeInstanceOf(Array);
      expect(ROLE_REQUIREMENTS[role].preferred).toBeInstanceOf(Array);
    }
  });

  it("reactor requires json_output", () => {
    expect(ROLE_REQUIREMENTS.reactor.required).toContain("json_output");
  });

  it("captain prefers teams", () => {
    expect(ROLE_REQUIREMENTS.captain.preferred).toContain("teams");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/types.test.ts`
Expected: 3 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/drivers/types.ts src/drivers/__tests__/types.test.ts
git commit -m "feat(drivers): add agent driver interface and role requirements"
```

---

### Task 2: Claude Driver (Extract from buildClaudeCmd)

**Files:**
- Create: `src/drivers/claude.ts`
- Test: `src/drivers/__tests__/claude.test.ts`

- [ ] **Step 1: Write the test for Claude driver**

```typescript
// src/drivers/__tests__/claude.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClaudeDriver } from "../claude.js";

// Mock execSync since we can't run `claude --version` in tests
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "claude --version") return "claude 2.3.0\n";
    return "";
  }),
}));

describe("claude driver", () => {
  const driver = createClaudeDriver();

  it("has name 'claude'", () => {
    expect(driver.name).toBe("claude");
  });

  it("has templateSuffix 'claude'", () => {
    expect(driver.templateSuffix).toBe("claude");
  });

  it("builds basic command", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
    });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("do something");
  });

  it("adds --model flag when model specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      model: "opus",
    });
    expect(cmd).toContain("--model opus");
  });

  it("adds --dangerously-skip-permissions when autoApprove", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      autoApprove: true,
    });
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("adds --append-system-prompt-file when promptFile specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      promptFile: "/tmp/captain.claude.md",
    });
    expect(cmd).toContain("--append-system-prompt-file /tmp/captain.claude.md");
  });

  it("probes and reports capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.version).toContain("2.3.0");
    expect(result.capabilities).toContain("teams");
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
    expect(result.capabilities).toContain("model_routing");
    expect(result.capabilities).toContain("skills");
    expect(result.capabilities).toContain("prompt_file");
  });

  it("parses JSONL output", () => {
    const raw = '{"type":"progress","content":"working..."}\n{"type":"result","result":"done"}';
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("done");
  });

  it("falls back to raw output when no JSON", () => {
    const raw = "plain text output";
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("plain text output");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/claude.test.ts`
Expected: FAIL — module `../claude.js` not found

- [ ] **Step 3: Implement the Claude driver**

```typescript
// src/drivers/claude.ts
import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createClaudeDriver(): AgentDriver {
  return {
    name: "claude",
    templateSuffix: "claude",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("claude --version", { encoding: "utf-8" }).trim();
        return {
          installed: true,
          version,
          capabilities: [
            "teams",
            "json_output",
            "model_routing",
            "skills",
            "auto_approve",
            "streaming",
            "prompt_file",
          ],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = "claude";

      if (opts.model) {
        cmd += ` --model ${opts.model}`;
      }

      if (opts.autoApprove) {
        cmd += " --dangerously-skip-permissions";
      }

      if (opts.promptFile) {
        cmd += ` --append-system-prompt-file ${opts.promptFile}`;
      }

      // Load cockpit plugin for skills
      const pluginDir = `${process.env.HOME}/.config/cockpit/plugin`;
      cmd += ` --plugin-dir ${pluginDir}`;

      cmd += ` -p "${opts.prompt.replace(/"/g, '\\"')}"`;
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      const lines = raw.trim().split("\n").filter((l) => l.startsWith("{"));
      if (lines.length === 0) {
        return { status: "success", output: raw.trim() };
      }
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        return { status: "success", output: last.result || last.content || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process may already be gone
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/claude.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/drivers/claude.ts src/drivers/__tests__/claude.test.ts
git commit -m "feat(drivers): implement Claude Code driver"
```

---

### Task 3: Codex, Gemini, and Aider Drivers

**Files:**
- Create: `src/drivers/codex.ts`
- Create: `src/drivers/gemini.ts`
- Create: `src/drivers/aider.ts`
- Test: `src/drivers/__tests__/codex.test.ts`
- Test: `src/drivers/__tests__/gemini.test.ts`
- Test: `src/drivers/__tests__/aider.test.ts`

- [ ] **Step 1: Write tests for all three drivers**

```typescript
// src/drivers/__tests__/codex.test.ts
import { describe, it, expect, vi } from "vitest";
import { createCodexDriver } from "../codex.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "codex --version") return "codex 1.2.0\n";
    if (cmd.includes("--help")) return "exec  Run a task non-interactively\n";
    return "";
  }),
}));

describe("codex driver", () => {
  const driver = createCodexDriver();

  it("has name 'codex'", () => {
    expect(driver.name).toBe("codex");
    expect(driver.templateSuffix).toBe("generic");
  });

  it("builds command with --json and --full-auto", () => {
    const cmd = driver.buildCommand({
      prompt: "fix the bug",
      workdir: "/tmp/test",
      role: "crew",
      autoApprove: true,
    });
    expect(cmd).toContain("codex exec");
    expect(cmd).toContain("--json");
    expect(cmd).toContain("--full-auto");
  });

  it("probes capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
    expect(result.capabilities).toContain("sandbox");
  });

  it("parses JSONL output", () => {
    const raw = '{"output":"task done"}\n';
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("task done");
  });
});
```

```typescript
// src/drivers/__tests__/gemini.test.ts
import { describe, it, expect, vi } from "vitest";
import { createGeminiDriver } from "../gemini.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "gemini --version") return "gemini 0.4.0\n";
    return "";
  }),
}));

describe("gemini driver", () => {
  const driver = createGeminiDriver();

  it("has name 'gemini'", () => {
    expect(driver.name).toBe("gemini");
    expect(driver.templateSuffix).toBe("generic");
  });

  it("builds command with -p and --yolo", () => {
    const cmd = driver.buildCommand({
      prompt: "explore this",
      workdir: "/tmp/test",
      role: "exploration",
      autoApprove: true,
      jsonOutput: true,
    });
    expect(cmd).toContain("gemini -p");
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("--output-format json");
  });

  it("probes capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
  });

  it("parses JSON output", () => {
    const raw = '{"response":"found it"}';
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("found it");
  });

  it("falls back to raw text", () => {
    const raw = "plain response text";
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("plain response text");
  });
});
```

```typescript
// src/drivers/__tests__/aider.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAiderDriver } from "../aider.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "aider --version") return "aider 0.82.0\n";
    return "";
  }),
}));

describe("aider driver", () => {
  const driver = createAiderDriver();

  it("has name 'aider'", () => {
    expect(driver.name).toBe("aider");
    expect(driver.templateSuffix).toBe("generic");
  });

  it("builds command with --message and --yes", () => {
    const cmd = driver.buildCommand({
      prompt: "refactor the module",
      workdir: "/tmp/test",
      role: "crew",
      model: "gpt-4.1",
      autoApprove: true,
    });
    expect(cmd).toContain('aider --message');
    expect(cmd).toContain("--model gpt-4.1");
    expect(cmd).toContain("--yes");
    expect(cmd).toContain("--no-stream");
  });

  it("probes capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("model_routing");
    expect(result.capabilities).not.toContain("json_output");
    expect(result.capabilities).not.toContain("teams");
  });

  it("returns raw text output", () => {
    const raw = "Applied changes to file.py";
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("Applied changes to file.py");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/codex.test.ts src/drivers/__tests__/gemini.test.ts src/drivers/__tests__/aider.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement Codex driver**

```typescript
// src/drivers/codex.ts
import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createCodexDriver(): AgentDriver {
  return {
    name: "codex",
    templateSuffix: "generic",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("codex --version", { encoding: "utf-8" }).trim();
        const help = execSync("codex --help", { encoding: "utf-8" });
        const hasExec = help.includes("exec");
        return {
          installed: true,
          version,
          capabilities: [
            "auto_approve",
            "json_output",
            "sandbox",
            ...(hasExec ? ["streaming" as const] : []),
          ],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = `codex exec "${opts.prompt.replace(/"/g, '\\"')}" --json`;
      if (opts.autoApprove) cmd += " --full-auto";
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      const lines = raw.trim().split("\n").filter((l) => l.startsWith("{"));
      if (lines.length === 0) {
        return { status: "success", output: raw.trim() };
      }
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        return { status: "success", output: last.output || last.result || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    },
  };
}
```

- [ ] **Step 4: Implement Gemini driver**

```typescript
// src/drivers/gemini.ts
import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createGeminiDriver(): AgentDriver {
  return {
    name: "gemini",
    templateSuffix: "generic",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("gemini --version", { encoding: "utf-8" }).trim();
        return {
          installed: true,
          version,
          capabilities: ["auto_approve", "json_output", "streaming"],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = `gemini -p "${opts.prompt.replace(/"/g, '\\"')}"`;
      if (opts.autoApprove) cmd += " --yolo";
      if (opts.jsonOutput) cmd += " --output-format json";
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      try {
        const parsed = JSON.parse(raw.trim());
        return { status: "success", output: parsed.response || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    },
  };
}
```

- [ ] **Step 5: Implement Aider driver**

```typescript
// src/drivers/aider.ts
import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createAiderDriver(): AgentDriver {
  return {
    name: "aider",
    templateSuffix: "generic",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("aider --version", { encoding: "utf-8" }).trim();
        return {
          installed: true,
          version,
          capabilities: ["auto_approve", "model_routing"],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = `aider --message "${opts.prompt.replace(/"/g, '\\"')}" --no-stream`;
      if (opts.model) cmd += ` --model ${opts.model}`;
      if (opts.autoApprove) cmd += " --yes";
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      return { status: "success", output: raw.trim() };
    },

    async stop(pid: number): Promise<void> {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    },
  };
}
```

- [ ] **Step 6: Run all driver tests**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/drivers/codex.ts src/drivers/gemini.ts src/drivers/aider.ts \
  src/drivers/__tests__/codex.test.ts src/drivers/__tests__/gemini.test.ts src/drivers/__tests__/aider.test.ts
git commit -m "feat(drivers): add Codex, Gemini, and Aider drivers"
```

---

### Task 4: Capability Registry

**Files:**
- Create: `src/drivers/registry.ts`
- Test: `src/drivers/__tests__/registry.test.ts`

- [ ] **Step 1: Write registry tests**

```typescript
// src/drivers/__tests__/registry.test.ts
import { describe, it, expect, vi } from "vitest";
import { CapabilityRegistry } from "../registry.js";
import type { AgentDriver, AgentProbeResult } from "../types.js";

function mockDriver(name: string, capabilities: string[], installed = true): AgentDriver {
  return {
    name,
    templateSuffix: name === "claude" ? "claude" : "generic",
    probe: vi.fn(async (): Promise<AgentProbeResult> => ({
      installed,
      version: "1.0.0",
      capabilities: capabilities as any[],
    })),
    buildCommand: vi.fn(() => `${name} run`),
    parseOutput: vi.fn((raw) => ({ status: "success" as const, output: raw })),
    stop: vi.fn(async () => {}),
  };
}

describe("CapabilityRegistry", () => {
  it("probes all registered drivers on init", async () => {
    const claude = mockDriver("claude", ["auto_approve", "teams", "json_output", "model_routing", "skills"]);
    const codex = mockDriver("codex", ["auto_approve", "json_output", "sandbox"]);

    const registry = new CapabilityRegistry({ claude, codex });
    await registry.probeAll();

    expect(claude.probe).toHaveBeenCalledOnce();
    expect(codex.probe).toHaveBeenCalledOnce();
  });

  it("returns driver by name", async () => {
    const claude = mockDriver("claude", ["auto_approve"]);
    const registry = new CapabilityRegistry({ claude });
    await registry.probeAll();

    expect(registry.getDriver("claude")).toBe(claude);
  });

  it("throws for unknown agent", async () => {
    const registry = new CapabilityRegistry({});
    await registry.probeAll();

    expect(() => registry.getDriver("unknown")).toThrow("No driver registered for agent 'unknown'");
  });

  it("validates required capabilities — blocks when missing", async () => {
    const aider = mockDriver("aider", ["auto_approve", "model_routing"]);
    const registry = new CapabilityRegistry({ aider });
    await registry.probeAll();

    const result = registry.validateRole("aider", "reactor");
    expect(result.allowed).toBe(false);
    expect(result.missingRequired).toContain("json_output");
  });

  it("validates preferred capabilities — warns when missing", async () => {
    const codex = mockDriver("codex", ["auto_approve", "json_output", "sandbox"]);
    const registry = new CapabilityRegistry({ codex });
    await registry.probeAll();

    const result = registry.validateRole("codex", "captain");
    expect(result.allowed).toBe(true);
    expect(result.missingPreferred).toContain("teams");
  });

  it("validates — passes when all capabilities present", async () => {
    const claude = mockDriver("claude", ["auto_approve", "teams", "json_output", "model_routing", "skills"]);
    const registry = new CapabilityRegistry({ claude });
    await registry.probeAll();

    const result = registry.validateRole("claude", "captain");
    expect(result.allowed).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.missingPreferred).toEqual([]);
  });

  it("skips uninstalled agents", async () => {
    const missing = mockDriver("missing", [], false);
    const registry = new CapabilityRegistry({ missing });
    await registry.probeAll();

    const result = registry.validateRole("missing", "crew");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not installed");
  });

  it("lists installed agents", async () => {
    const claude = mockDriver("claude", ["auto_approve"]);
    const codex = mockDriver("codex", ["auto_approve"], false);
    const registry = new CapabilityRegistry({ claude, codex });
    await registry.probeAll();

    const installed = registry.installedAgents();
    expect(installed).toEqual(["claude"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the registry**

```typescript
// src/drivers/registry.ts
import { ROLE_REQUIREMENTS, type AgentCapability, type AgentDriver, type AgentProbeResult, type Role } from "./types.js";

export interface ValidationResult {
  allowed: boolean;
  missingRequired: AgentCapability[];
  missingPreferred: AgentCapability[];
  reason?: string;
}

export class CapabilityRegistry {
  private drivers: Record<string, AgentDriver>;
  private probeResults: Record<string, AgentProbeResult> = {};

  constructor(drivers: Record<string, AgentDriver>) {
    this.drivers = drivers;
  }

  async probeAll(): Promise<void> {
    for (const [name, driver] of Object.entries(this.drivers)) {
      this.probeResults[name] = await driver.probe();
    }
  }

  getDriver(name: string): AgentDriver {
    const driver = this.drivers[name];
    if (!driver) {
      throw new Error(`No driver registered for agent '${name}'`);
    }
    return driver;
  }

  getProbeResult(name: string): AgentProbeResult | undefined {
    return this.probeResults[name];
  }

  validateRole(agent: string, role: Role): ValidationResult {
    const probe = this.probeResults[agent];
    if (!probe || !probe.installed) {
      return {
        allowed: false,
        missingRequired: [],
        missingPreferred: [],
        reason: `Agent '${agent}' is not installed`,
      };
    }

    const reqs = ROLE_REQUIREMENTS[role];
    const caps = new Set(probe.capabilities);

    const missingRequired = reqs.required.filter((c) => !caps.has(c));
    const missingPreferred = reqs.preferred.filter((c) => !caps.has(c));

    if (missingRequired.length > 0) {
      return {
        allowed: false,
        missingRequired,
        missingPreferred,
        reason: `${agent} cannot be ${role}: missing required capabilities [${missingRequired.join(", ")}]`,
      };
    }

    return { allowed: true, missingRequired: [], missingPreferred };
  }

  installedAgents(): string[] {
    return Object.entries(this.probeResults)
      .filter(([, probe]) => probe.installed)
      .map(([name]) => name);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd ~/me/claude-cockpit && npx vitest run src/drivers/__tests__/registry.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/drivers/registry.ts src/drivers/__tests__/registry.test.ts
git commit -m "feat(drivers): add capability registry with role validation"
```

---

### Task 5: Driver Index (Re-exports)

**Files:**
- Create: `src/drivers/index.ts`

- [ ] **Step 1: Create the barrel export**

```typescript
// src/drivers/index.ts
export { createClaudeDriver } from "./claude.js";
export { createCodexDriver } from "./codex.js";
export { createGeminiDriver } from "./gemini.js";
export { createAiderDriver } from "./aider.js";
export { CapabilityRegistry } from "./registry.js";
export type {
  AgentDriver,
  AgentCapability,
  AgentProbeResult,
  AgentResult,
  SpawnOptions,
  Role,
  RoleRequirements,
} from "./types.js";
export { ROLE_REQUIREMENTS } from "./types.js";
```

- [ ] **Step 2: Verify build compiles**

Run: `cd ~/me/claude-cockpit && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/drivers/index.ts
git commit -m "feat(drivers): add barrel index for driver exports"
```

---

### Task 6: Config Schema Update + Backward Compat

**Files:**
- Modify: `src/config.ts:21-98` (type definitions + defaults + loadConfig)
- Modify: `src/config.test.ts` (add tests)

- [ ] **Step 1: Write tests for new config types and migration**

Add these tests to `src/config.test.ts`:

```typescript
// Append to existing describe block in src/config.test.ts

  it("supports new agents config", () => {
    const config = getDefaultConfig();
    expect(config.agents).toBeDefined();
    expect(config.agents!.claude).toEqual({ cli: "claude", driver: "claude" });
  });

  it("supports new roles config", () => {
    const config = getDefaultConfig();
    expect(config.defaults.roles).toBeDefined();
    expect(config.defaults.roles!.command).toEqual({ agent: "claude", model: "opus" });
    expect(config.defaults.roles!.crew).toEqual({ agent: "claude", model: "sonnet" });
  });

  it("migrates old models config to roles on load", () => {
    // Write old-format config
    const oldConfig = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "default", captain: "acceptEdits" },
        models: { command: "opus", captain: "opus", crew: "sonnet", reactor: "sonnet", exploration: "haiku", review: "opus" },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(oldConfig));

    const loaded = loadConfig(configPath);
    // Old models should be migrated to roles
    expect(loaded.defaults.roles).toBeDefined();
    expect(loaded.defaults.roles!.crew).toEqual({ agent: "claude", model: "sonnet" });
    // Old models field should still be present for backward compat
    expect(loaded.defaults.models).toBeDefined();
  });

  it("preserves new roles config on load", () => {
    const newConfig = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      agents: {
        claude: { cli: "claude", driver: "claude" },
        codex: { cli: "codex", driver: "codex" },
      },
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "default", captain: "acceptEdits" },
        roles: {
          command: { agent: "claude", model: "opus" },
          captain: { agent: "claude", model: "opus" },
          crew: { agent: "codex", model: "o3" },
          reactor: { agent: "claude", model: "sonnet" },
          exploration: { agent: "claude", model: "haiku" },
        },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(newConfig));

    const loaded = loadConfig(configPath);
    expect(loaded.defaults.roles!.crew).toEqual({ agent: "codex", model: "o3" });
    expect(loaded.agents!.codex).toEqual({ cli: "codex", driver: "codex" });
  });
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd ~/me/claude-cockpit && npx vitest run src/config.test.ts`
Expected: FAIL — `roles` and `agents` properties not defined

- [ ] **Step 3: Update config.ts with new types and migration**

Add these types after `ModelRoutingConfig` (around line 30):

```typescript
export interface AgentEntry {
  cli: string;      // CLI command name (e.g., "claude", "codex", "gemini")
  driver: string;   // Driver to use (e.g., "claude", "codex", "gemini", "aider")
}

export interface RoleAssignment {
  agent: string;    // Agent name (key in agents map)
  model?: string;   // Agent-native model name (e.g., "opus", "o3", "flash")
}

export type RoleConfig = Partial<Record<"command" | "captain" | "crew" | "reactor" | "exploration", RoleAssignment>>;
```

Add optional fields to `CockpitConfig`:

```typescript
export interface CockpitConfig {
  commandName: string;
  hubVault: string;
  projects: Record<string, ProjectConfig>;
  agents?: Record<string, AgentEntry>;
  defaults: {
    maxCrew: number;
    worktreeDir: string;
    teammateMode: string;
    permissions: PermissionConfig;
    models?: ModelRoutingConfig;  // kept for backward compat
    roles?: RoleConfig;
  };
  metrics: {
    enabled: boolean;
    path: string;
  };
}
```

Update `getDefaultConfig()` to include agents and roles:

```typescript
export function getDefaultConfig(): CockpitConfig {
  return {
    commandName: "\u{1F3DB}\u{FE0F} command",
    hubVault: path.join(os.homedir(), "cockpit-hub"),
    projects: {},
    agents: {
      claude: { cli: "claude", driver: "claude" },
    },
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: {
        command: "default",
        captain: "acceptEdits",
      },
      models: {
        command: "opus",
        captain: "opus",
        crew: "sonnet",
        reactor: "sonnet",
        exploration: "haiku",
        review: "opus",
      },
      roles: {
        command: { agent: "claude", model: "opus" },
        captain: { agent: "claude", model: "opus" },
        crew: { agent: "claude", model: "sonnet" },
        reactor: { agent: "claude", model: "sonnet" },
        exploration: { agent: "claude", model: "haiku" },
      },
    },
    metrics: {
      enabled: true,
      path: path.join(CONFIG_DIR, "metrics.json"),
    },
  };
}
```

Update `loadConfig()` to migrate old format:

```typescript
export function loadConfig(configPath = DEFAULT_CONFIG_PATH): CockpitConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as CockpitConfig;

    // Backward compat: migrate models → roles if roles not set
    if (config.defaults.models && !config.defaults.roles) {
      const m = config.defaults.models;
      config.defaults.roles = {
        command: { agent: "claude", model: m.command },
        captain: { agent: "claude", model: m.captain },
        crew: { agent: "claude", model: m.crew },
        reactor: { agent: "claude", model: m.reactor },
        exploration: { agent: "claude", model: m.exploration },
      };
    }

    // Ensure agents has at least claude
    if (!config.agents) {
      config.agents = { claude: { cli: "claude", driver: "claude" } };
    }

    return config;
  } catch {
    return getDefaultConfig();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd ~/me/claude-cockpit && npx vitest run src/config.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Verify full build**

Run: `cd ~/me/claude-cockpit && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): add agents and roles config with backward-compat migration"
```

---

### Task 7: Integrate Registry into launch.ts

**Files:**
- Modify: `src/commands/launch.ts:8,126-152,238-239`

- [ ] **Step 1: Replace buildClaudeCmd with driver-based command building**

Update imports at the top of `launch.ts`:

```typescript
// Replace this import:
import { loadConfig, resolveHome, type ModelRoutingConfig } from "../config.js";
// With:
import { loadConfig, resolveHome } from "../config.js";
import { createClaudeDriver, createCodexDriver, createGeminiDriver, createAiderDriver, CapabilityRegistry } from "../drivers/index.js";
import type { Role } from "../drivers/types.js";
```

Replace the `buildClaudeCmd` function (lines 126-152) with a driver-aware version:

```typescript
function buildAgentCmd(
  agentName: string,
  registry: CapabilityRegistry,
  role: string,
  fresh: boolean,
  permissionMode: string,
  model?: string,
): string {
  const driver = registry.getDriver(agentName);

  // For Claude, handle fresh vs continue and permission mode specially
  if (driver.name === "claude") {
    let cmd = fresh ? "claude" : "claude -c";

    if (permissionMode === "acceptEdits") {
      cmd += " --permission-mode acceptEdits";
    } else if (permissionMode === "bypassPermissions") {
      cmd += " --dangerously-skip-permissions";
    }

    if (model) {
      cmd += ` --model ${model}`;
    }

    const roleFile = path.join(TEMPLATES_DIR, `${role}.claude.md`);
    // Fall back to old naming if new name doesn't exist yet
    const legacyRoleFile = path.join(TEMPLATES_DIR, `${role}.CLAUDE.md`);
    const actualRoleFile = fs.existsSync(roleFile) ? roleFile : (fs.existsSync(legacyRoleFile) ? legacyRoleFile : null);
    if (actualRoleFile) {
      cmd += ` --append-system-prompt-file ${actualRoleFile}`;
    }

    const pluginDir = path.join(TEMPLATES_DIR, "..", "plugin");
    if (fs.existsSync(pluginDir)) {
      cmd += ` --plugin-dir ${pluginDir}`;
    }

    return cmd;
  }

  // For non-Claude agents, use the driver's buildCommand
  const roleFile = path.join(TEMPLATES_DIR, `${role}.${driver.templateSuffix}.md`);
  return driver.buildCommand({
    prompt: `You are a cockpit ${role}. Read your instructions from ${roleFile} and begin.`,
    workdir: process.cwd(),
    role: role as Role,
    model,
    autoApprove: true,
    promptFile: fs.existsSync(roleFile) ? roleFile : undefined,
  });
}
```

Create the registry once at the start of the action handler, and update `launchOne` to use it:

In the `.action()` callback, before the `launchOne` function definition, add:

```typescript
    // Build driver registry
    const drivers: Record<string, any> = {
      claude: createClaudeDriver(),
      codex: createCodexDriver(),
      gemini: createGeminiDriver(),
      aider: createAiderDriver(),
    };
    const registry = new CapabilityRegistry(drivers);
```

Inside `launchOne`, replace lines 238-239:

```typescript
      // Old code:
      // const model = config.defaults.models?.[role as keyof ModelRoutingConfig];
      // const claudeCmd = buildClaudeCmd(role, forceFresh, permissionMode, model);

      // New code:
      const roleConfig = config.defaults.roles?.[role as keyof NonNullable<typeof config.defaults.roles>];
      const agentName = roleConfig?.agent || "claude";
      const model = roleConfig?.model || config.defaults.models?.[role as keyof import("../config.js").ModelRoutingConfig];
      const claudeCmd = buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model);
```

- [ ] **Step 2: Verify build compiles**

Run: `cd ~/me/claude-cockpit && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all existing tests to confirm no regressions**

Run: `cd ~/me/claude-cockpit && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/launch.ts
git commit -m "refactor(launch): replace buildClaudeCmd with driver-based command building"
```

---

### Task 8: Update doctor.ts with Agent Probing

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Add agent probing section to doctor command**

After the existing checks (around line 111), add an agent probe section:

```typescript
    // --- Agent Probes ---
    console.log(chalk.bold("\nAgent Drivers\n"));

    const { createClaudeDriver, createCodexDriver, createGeminiDriver, createAiderDriver, CapabilityRegistry } = await import("../drivers/index.js");

    const agentDrivers = {
      claude: createClaudeDriver(),
      codex: createCodexDriver(),
      gemini: createGeminiDriver(),
      aider: createAiderDriver(),
    };

    const registry = new CapabilityRegistry(agentDrivers);
    await registry.probeAll();

    for (const [name, driver] of Object.entries(agentDrivers)) {
      const probe = registry.getProbeResult(name);
      if (!probe || !probe.installed) {
        console.log(`  ${chalk.gray("○ SKIP")}  ${name} — not installed`);
        continue;
      }
      const caps = probe.capabilities.join(", ");
      console.log(`  ${chalk.green("✔ FOUND")} ${name} ${chalk.gray(probe.version)} — [${caps}]`);
    }

    // Show role assignments from config
    if (config.defaults.roles) {
      console.log(chalk.bold("\nRole Assignments\n"));
      for (const [role, assignment] of Object.entries(config.defaults.roles)) {
        const validation = registry.validateRole(assignment.agent, role as any);
        const statusIcon = validation.allowed ? chalk.green("✔") : chalk.red("✘");
        const warns = validation.missingPreferred.length > 0
          ? chalk.yellow(` (missing preferred: ${validation.missingPreferred.join(", ")})`)
          : "";
        console.log(`  ${statusIcon} ${role}: ${assignment.agent}${assignment.model ? ` (${assignment.model})` : ""}${warns}`);
        if (!validation.allowed && validation.reason) {
          console.log(`    ${chalk.red(validation.reason)}`);
        }
      }
    }
```

- [ ] **Step 2: Verify build compiles**

Run: `cd ~/me/claude-cockpit && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "feat(doctor): add agent probing and role validation to health check"
```

---

### Task 9: Role Templates — Rename + Create Generic Variants

**Files:**
- Rename: `orchestrator/captain.CLAUDE.md` → `orchestrator/captain.claude.md`
- Rename: `orchestrator/command.CLAUDE.md` → `orchestrator/command.claude.md`
- Rename: `orchestrator/crew.CLAUDE.md` → `orchestrator/crew.claude.md`
- Rename: `orchestrator/reactor.CLAUDE.md` → `orchestrator/reactor.claude.md`
- Rename: `orchestrator/learnings.CLAUDE.md` → `orchestrator/learnings.claude.md`
- Create: `orchestrator/captain.generic.md`
- Create: `orchestrator/crew.generic.md`

- [ ] **Step 1: Rename existing templates**

```bash
cd ~/me/claude-cockpit/orchestrator
git mv captain.CLAUDE.md captain.claude.md
git mv command.CLAUDE.md command.claude.md
git mv crew.CLAUDE.md crew.claude.md
git mv reactor.CLAUDE.md reactor.claude.md
git mv learnings.CLAUDE.md learnings.claude.md
```

- [ ] **Step 2: Update init.ts to handle new naming pattern**

In `src/commands/init.ts`, change the template copy logic (line 91) from:

```typescript
        if (file.endsWith(".CLAUDE.md")) {
```

to:

```typescript
        if (file.endsWith(".claude.md") || file.endsWith(".generic.md") || file.endsWith(".CLAUDE.md")) {
```

- [ ] **Step 3: Update launch.ts computeTemplateHash to handle new naming**

In `src/commands/launch.ts`, change `computeTemplateHash` (line 42) from:

```typescript
  const roleFile = path.join(TEMPLATES_DIR, `${role}.CLAUDE.md`);
```

to:

```typescript
  const roleFile = path.join(TEMPLATES_DIR, `${role}.claude.md`);
  const legacyRoleFile = path.join(TEMPLATES_DIR, `${role}.CLAUDE.md`);
```

And update the hash to check both:

```typescript
  if (fs.existsSync(roleFile)) {
    hash.update(fs.readFileSync(roleFile, "utf-8"));
  } else if (fs.existsSync(legacyRoleFile)) {
    hash.update(fs.readFileSync(legacyRoleFile, "utf-8"));
  }
```

- [ ] **Step 4: Update spawn-workspace.sh template hash line**

In `scripts/spawn-workspace.sh`, change line 40 and 58 from:

```bash
CURRENT_HASH=$(cat "${TEMPLATES_DIR}/${ROLE}.CLAUDE.md" ...
```

to:

```bash
ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.claude.md"
[ ! -f "$ROLE_FILE" ] && ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.CLAUDE.md"
CURRENT_HASH=$(cat "$ROLE_FILE" ...
```

And update lines 108-110 similarly for the role file reference.

- [ ] **Step 5: Create captain.generic.md**

```markdown
# Captain — Generic Agent

You are a project captain coordinating work via cmux workspaces and status files.

## Rules

1. You coordinate crew members working in git worktrees.
2. Communicate with crew via cmux: `cmux send --workspace "<crew-name>" "<message>"`
3. Monitor crew status via spoke vault: read `{spokeVault}/status.md`
4. Write your own status updates:
   ```bash
   ~/.config/cockpit/scripts/write-status.sh "{spokeVault}" "{field}" "{value}" "{message}"
   ```
5. When a task completes, review the crew's branch diff and merge if appropriate.
6. Report completion to command via cmux:
   ```bash
   CMD_WS=$(cmux list-workspaces 2>&1 | grep 'command' | awk '{print $1}')
   cmux send --workspace "$CMD_WS" "Captain report: {project} — task DONE. Branch: {branch}."
   cmux send-key --workspace "$CMD_WS" Enter
   ```
7. Record learnings: `~/.config/cockpit/scripts/record-learning.sh "{spokeVault}" "{category}" "{description}" "{tags}"`

## Crew Spawning

Ask cockpit to spawn crew workspaces. Each crew member runs in their own worktree.
Provide clear task descriptions with: what to change, which files, which branch to base from.

## Session Lifecycle

- On startup: check for handoff files, read recent daily logs
- On shutdown: write handoff file for next session's context
```

- [ ] **Step 6: Create crew.generic.md**

```markdown
# Crew Member — Generic Agent

You are a crew member working on a specific task in a git worktree.

## Rules

1. You are in a worktree, NOT the main branch. Do not modify files outside your worktree.
2. When your task is complete, commit your work and report back.
3. Write status updates via:
   ```bash
   ~/.config/cockpit/scripts/write-status.sh "{spokeVault}" "tasks_completed" "1" "Done: {description}"
   ```
4. Commit your work frequently with descriptive messages.

## Your Worktree

Your working directory is a git worktree. Your branch is isolated from main. Work freely.

## Task Completion

When done:
1. Commit all changes
2. Write a brief summary of what you did and any issues encountered
3. Your captain will review and merge your branch
```

- [ ] **Step 7: Verify build**

Run: `cd ~/me/claude-cockpit && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add orchestrator/ src/commands/init.ts src/commands/launch.ts scripts/spawn-workspace.sh
git commit -m "refactor(templates): rename *.CLAUDE.md to *.claude.md, add generic role templates"
```

---

### Task 10: Update spawn-workspace.sh for Multi-Agent

**Files:**
- Modify: `scripts/spawn-workspace.sh`

- [ ] **Step 1: Add agent resolution to spawn-workspace.sh**

After the model routing section (line ~105), add agent resolution:

```bash
# Read agent from roles config (new format) or fall back to "claude"
AGENT=$(python3 -c "
import json
try:
    cfg = json.load(open('${HOME}/.config/cockpit/config.json'))
    roles = cfg.get('defaults', {}).get('roles', {})
    role_cfg = roles.get('$ROLE', {})
    print(role_cfg.get('agent', 'claude'))
except: print('claude')
" 2>/dev/null)

# Read model from roles config (new format) or fall back to models config
MODEL=$(python3 -c "
import json
try:
    cfg = json.load(open('${HOME}/.config/cockpit/config.json'))
    roles = cfg.get('defaults', {}).get('roles', {})
    role_cfg = roles.get('$ROLE', {})
    model = role_cfg.get('model', '')
    if not model:
        model = cfg.get('defaults', {}).get('models', {}).get('$ROLE', '')
    print(model)
except: print('')
" 2>/dev/null)
```

Replace the Claude command building section (lines 71-117) with agent-aware logic:

```bash
# --- Build agent command based on resolved agent ---
case "$AGENT" in
  claude)
    if [ "$FRESH" = "true" ]; then
      AGENT_CMD="claude"
    else
      AGENT_CMD="claude -c"
    fi

    if [ "$PERM_MODE" = "acceptEdits" ]; then
      AGENT_CMD="${AGENT_CMD} --permission-mode acceptEdits"
    elif [ "$PERM_MODE" = "bypassPermissions" ]; then
      AGENT_CMD="${AGENT_CMD} --dangerously-skip-permissions"
    fi

    if [ -n "$MODEL" ]; then
      AGENT_CMD="${AGENT_CMD} --model ${MODEL}"
    fi

    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.claude.md"
    [ ! -f "$ROLE_FILE" ] && ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.CLAUDE.md"
    if [ -f "$ROLE_FILE" ]; then
      AGENT_CMD="${AGENT_CMD} --append-system-prompt-file ${ROLE_FILE}"
    fi

    PLUGIN_DIR="${HOME}/.config/cockpit/plugin"
    if [ -d "$PLUGIN_DIR" ]; then
      AGENT_CMD="${AGENT_CMD} --plugin-dir ${PLUGIN_DIR}"
    fi
    ;;

  codex)
    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.generic.md"
    AGENT_CMD="codex exec --json --full-auto"
    if [ -f "$ROLE_FILE" ]; then
      AGENT_CMD="${AGENT_CMD} -p \"Read instructions from ${ROLE_FILE} and begin.\""
    fi
    ;;

  gemini)
    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.generic.md"
    AGENT_CMD="gemini --yolo"
    if [ -f "$ROLE_FILE" ]; then
      AGENT_CMD="${AGENT_CMD} -p \"Read instructions from ${ROLE_FILE} and begin.\""
    fi
    ;;

  aider)
    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.generic.md"
    AGENT_CMD="aider --yes --no-stream"
    if [ -n "$MODEL" ]; then
      AGENT_CMD="${AGENT_CMD} --model ${MODEL}"
    fi
    ;;

  *)
    echo "ERROR: Unknown agent '${AGENT}' for role '${ROLE}'"
    exit 1
    ;;
esac
```

Update the workspace spawn line to use `$AGENT_CMD` instead of `$CLAUDE_CMD`:

```bash
NEW_UUID=$("$CMUX" new-workspace --command "$AGENT_CMD" --cwd "$CWD" 2>&1 | awk '{print $2}')
```

Update the initial prompt section — only send startup prompts for Claude agents:

```bash
if [ "$AGENT" = "claude" ]; then
  if [ "$ROLE" = "captain" ]; then
    (sleep 3 && "$CMUX" send --workspace "$NEW_UUID" "Run your startup checklist: use the cockpit:captain-ops skill, complete all startup steps, then report ready." 2>/dev/null) &
  elif [ "$ROLE" = "command" ]; then
    (sleep 3 && "$CMUX" send --workspace "$NEW_UUID" "Run your startup checklist: use the cockpit:command-ops skill, complete your daily briefing, then report ready." 2>/dev/null) &
  elif [ "$ROLE" = "reactor" ]; then
    (sleep 3 && "$CMUX" send --workspace "$NEW_UUID" "Run your startup checklist: use the cockpit:reactor-ops skill, verify gh auth, read reactions.json, then start your poll loop." 2>/dev/null) &
  fi
fi
```

Update the final echo:

```bash
echo "Spawned workspace: $NAME at $CWD (role: $ROLE, agent: $AGENT, fresh: $FRESH)"
```

- [ ] **Step 2: Make sure script is still valid bash**

Run: `bash -n ~/me/claude-cockpit/scripts/spawn-workspace.sh`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add scripts/spawn-workspace.sh
git commit -m "feat(spawn): add multi-agent support to spawn-workspace.sh"
```

---

### Task 11: Final Integration Test + Build Verification

**Files:**
- Run all tests and build

- [ ] **Step 1: Run full test suite**

Run: `cd ~/me/claude-cockpit && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Full TypeScript build**

Run: `cd ~/me/claude-cockpit && npm run build`
Expected: Build succeeds, no errors

- [ ] **Step 3: Verify cockpit CLI still works**

Run: `cd ~/me/claude-cockpit && npm link && cockpit doctor`
Expected: Doctor runs, shows existing checks PLUS new "Agent Drivers" section with at least Claude detected

- [ ] **Step 4: Commit any final fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: integration fixes for multi-agent support"
```
