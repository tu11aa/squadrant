# Multi-Agent Support — Design Spec

> **✅ Shipped** (multi-agent support (driver model in packages/), 2026-04-08). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-04-08  
**Status:** Draft — design only, implementation in next sprint  
**Issue:** TBD (create when sprint starts)

## Problem

Claude Cockpit is tightly coupled to Claude Code — 23 coupling points across 6 files. Every CLI invocation, model reference, coordination mechanism, and role template assumes Claude. This locks cockpit to a single vendor and prevents leveraging other agents' strengths (Codex's sandbox, Gemini's speed, Aider's multi-model support).

## Goal

Make cockpit agent-agnostic. Any AI coding CLI that can run headless in a terminal should be pluggable into any role (command, captain, crew, reactor, exploration). Claude Code remains the default and first-class agent — multi-agent is opt-in, not forced.

## Non-Goals

- Full plugin/extension system (that's #9, separate scope)
- Rewriting the orchestration layer (cmux + spoke vaults stay as-is)
- Supporting IDE-only tools (Windsurf, Cursor IDE mode) — CLI agents only

## Architecture: Thin Adapter Layer (Driver Model)

```
cockpit core
  └── src/drivers/
        ├── interface.ts     ← AgentDriver interface + types
        ├── claude.ts        ← Claude Code driver (extracted from buildClaudeCmd)
        ├── codex.ts         ← OpenAI Codex CLI driver
        ├── gemini.ts        ← Google Gemini CLI driver
        ├── aider.ts         ← Aider driver
        └── registry.ts      ← CapabilityRegistry (probes + routes)
```

Cockpit core never talks to agent CLIs directly — always through a driver. Adding a new agent = writing one driver file (~30-50 lines).

## 1. Agent Driver Interface

```typescript
interface AgentDriver {
  name: string;  // "claude", "codex", "gemini", "aider"

  // Detect if installed, discover capabilities
  probe(): Promise<AgentProbeResult>;

  // Build the CLI command for a given role + task
  buildCommand(opts: SpawnOptions): string;

  // Parse agent's stdout/stderr into a normalized result
  parseOutput(raw: string): AgentResult;

  // Graceful shutdown signal
  stop(pid: number): Promise<void>;
}

interface AgentProbeResult {
  installed: boolean;
  version: string;
  capabilities: AgentCapability[];
}

type AgentCapability =
  | "teams"           // Native agent team coordination (Claude only, currently)
  | "json_output"     // Structured JSON/JSONL output
  | "sandbox"         // Built-in sandboxing (Codex)
  | "model_routing"   // Can select sub-models (--model flag)
  | "skills"          // Plugin/skill system
  | "auto_approve"    // Non-interactive mode with auto-approval
  | "streaming"       // Real-time stdout streaming
  | "prompt_file";    // Can load system prompt from file

interface SpawnOptions {
  prompt: string;
  workdir: string;
  role: Role;
  model?: string;        // Agent-native model name (e.g., "opus", "o3", "flash")
  autoApprove?: boolean;
  jsonOutput?: boolean;
  promptFile?: string;   // Path to role template
}

interface AgentResult {
  status: "success" | "error" | "timeout";
  output: string;
  filesChanged?: string[];
}
```

## 2. Capability Registry & Role Routing

On startup (or `cockpit doctor`), cockpit probes all registered agents and builds a live capability map.

### Role Requirements

| Role | Required Capabilities | Preferred Capabilities |
|------|----------------------|----------------------|
| command | `auto_approve` | `teams`, `json_output` |
| captain | `auto_approve` | `teams`, `model_routing`, `skills` |
| crew | `auto_approve` | `json_output`, `sandbox` |
| reactor | `auto_approve`, `json_output` | — |
| exploration | `auto_approve` | — |

**Routing rules:**
- Required capability missing → **block** with error: `"codex cannot be reactor: missing 'json_output' capability"`
- Preferred capability missing → **warn** but allow: `"gemini as captain: no native teams — will use cmux + status files for coordination"`

### Probe Implementation

Each driver's `probe()` runs the agent's version/help command and parses the output:

- **Claude:** `claude --version` → parse version, capabilities known per version
- **Codex:** `codex --version` → check for `exec` subcommand, `--json`, `--full-auto`
- **Gemini:** `gemini --version` → check for `-p`, `--yolo`, `--output-format`
- **Aider:** `aider --version` → check for `--message`, `--yes`

Probed results are cached for the session (re-probe on `cockpit doctor` or `cockpit launch`).

## 3. Config Changes

### New Config Structure

```json
{
  "agents": {
    "claude": { "cli": "claude", "driver": "claude" },
    "codex": { "cli": "codex", "driver": "codex" },
    "gemini": { "cli": "gemini", "driver": "gemini" }
  },
  "defaults": {
    "roles": {
      "command": { "agent": "claude", "model": "opus" },
      "captain": { "agent": "claude", "model": "opus" },
      "crew": { "agent": "claude", "model": "sonnet" },
      "reactor": { "agent": "claude", "model": "sonnet" },
      "exploration": { "agent": "claude", "model": "haiku" }
    }
  }
}
```

**All defaults are Claude.** Multi-agent is opt-in — change a role's `agent` field to use a different agent.

### Backward Compatibility

Old config format:
```json
{ "defaults": { "models": { "crew": "sonnet" } } }
```

Automatically interpreted as:
```json
{ "defaults": { "roles": { "crew": { "agent": "claude", "model": "sonnet" } } } }
```

Migration handled in `loadConfig()` — old format is read and normalized, no breaking changes.

### Per-Project Override

Projects can override the default agent for specific roles:

```json
{
  "projects": {
    "brove": {
      "path": "~/projects/brove",
      "roles": {
        "exploration": { "agent": "gemini", "model": "flash" }
      }
    }
  }
}
```

## 4. Coordination Model

### cmux Is the Universal Bus

Every agent runs in a cmux workspace — this is already the case. The orchestration layer (cmux workspaces + spoke vault status files + handoff scripts) is agent-agnostic. Nothing changes here.

### Claude↔Claude: Native Agent Teams

When both captain and crew are Claude, use Agent Teams (`TeamCreate`, `SendMessage`) for real-time bidirectional messaging. This is the current behavior — no degradation.

### Mixed Agents: cmux + Status Files

When captain and crew are different agents:
1. Captain tells cockpit to spawn a crew workspace
2. Cockpit uses the crew's driver to build the CLI command
3. Command launches in a cmux workspace
4. Crew works in its worktree, commits changes, writes status via spoke vault scripts
5. Captain monitors via `cmux list-workspaces` and spoke vault status files
6. Captain reports to command via `cmux send` — same as today

The spoke vault scripts (`write-status.sh`, `record-learning.sh`, etc.) work from any agent because they're plain bash — the agent just needs to be told to run them in its prompt.

### Role Templates

Templates become per-agent:

```
orchestrator/
  captain.claude.md     ← uses TeamCreate, SendMessage, skills
  captain.generic.md    ← uses cmux send, status files, no native teams
  crew.claude.md        ← current crew.CLAUDE.md
  crew.generic.md       ← basic: read task, do work, commit, write status
  command.claude.md     ← current command role
  reactor.claude.md     ← current reactor role
```

The driver specifies which template to use. Claude driver → `*.claude.md`. All others → `*.generic.md` (or agent-specific if one exists).

## 5. Driver Implementations

### Claude Driver (extract from current code)

```typescript
// src/drivers/claude.ts — ~60 lines
const claude: AgentDriver = {
  name: "claude",

  async probe() {
    const version = exec("claude --version");
    return {
      installed: !!version,
      version,
      capabilities: ["teams", "json_output", "model_routing",
                      "skills", "auto_approve", "streaming", "prompt_file"]
    };
  },

  buildCommand({ prompt, workdir, role, model, autoApprove, promptFile }) {
    let cmd = `claude`;
    if (model) cmd += ` --model ${model}`;
    if (autoApprove) cmd += ` --dangerously-skip-permissions`;
    if (promptFile) cmd += ` --append-system-prompt-file ${promptFile}`;
    cmd += ` -p "${prompt}"`;
    return cmd;
  },

  parseOutput(raw) {
    // Parse JSONL output
    const lines = raw.trim().split("\n").filter(l => l.startsWith("{"));
    const last = JSON.parse(lines[lines.length - 1]);
    return { status: "success", output: last.result || raw };
  },

  async stop(pid) { process.kill(pid, "SIGTERM"); }
};
```

### Codex Driver

```typescript
// src/drivers/codex.ts — ~40 lines
const codex: AgentDriver = {
  name: "codex",

  async probe() {
    const version = exec("codex --version");
    const hasExec = exec("codex --help").includes("exec");
    return {
      installed: !!version,
      version,
      capabilities: [
        "auto_approve", "json_output", "sandbox",
        ...(hasExec ? ["streaming"] : [])
      ]
    };
  },

  buildCommand({ prompt, autoApprove }) {
    let cmd = `codex exec "${prompt}" --json`;
    if (autoApprove) cmd += ` --full-auto`;
    return cmd;
  },

  parseOutput(raw) {
    const lines = raw.trim().split("\n").filter(l => l.startsWith("{"));
    const last = JSON.parse(lines[lines.length - 1]);
    return { status: "success", output: last.output || raw };
  },

  async stop(pid) { process.kill(pid, "SIGTERM"); }
};
```

### Gemini Driver

```typescript
// src/drivers/gemini.ts — ~40 lines
const gemini: AgentDriver = {
  name: "gemini",

  async probe() {
    const version = exec("gemini --version");
    return {
      installed: !!version,
      version,
      capabilities: ["auto_approve", "json_output", "streaming"]
    };
  },

  buildCommand({ prompt, autoApprove, jsonOutput }) {
    let cmd = `gemini -p "${prompt}"`;
    if (autoApprove) cmd += ` --yolo`;
    if (jsonOutput) cmd += ` --output-format json`;
    return cmd;
  },

  parseOutput(raw) {
    try {
      const parsed = JSON.parse(raw);
      return { status: "success", output: parsed.response || raw };
    } catch {
      return { status: "success", output: raw };
    }
  },

  async stop(pid) { process.kill(pid, "SIGTERM"); }
};
```

### Aider Driver

```typescript
// src/drivers/aider.ts — ~40 lines
const aider: AgentDriver = {
  name: "aider",

  async probe() {
    const version = exec("aider --version");
    return {
      installed: !!version,
      version,
      capabilities: ["auto_approve", "model_routing"]
      // No json_output, no sandbox, no teams
    };
  },

  buildCommand({ prompt, model, autoApprove }) {
    let cmd = `aider --message "${prompt}" --no-stream`;
    if (model) cmd += ` --model ${model}`;
    if (autoApprove) cmd += ` --yes`;
    return cmd;
  },

  parseOutput(raw) {
    // Aider outputs plain text — no structured format
    return { status: "success", output: raw };
  },

  async stop(pid) { process.kill(pid, "SIGTERM"); }
};
```

## 6. Refactoring Plan (High-Level)

### Files to Change

| File | Change | Impact |
|------|--------|--------|
| `src/drivers/interface.ts` | New — driver interface + types | Core abstraction |
| `src/drivers/claude.ts` | Extract from `buildClaudeCmd()` | Replace current coupling |
| `src/drivers/codex.ts` | New driver | New agent support |
| `src/drivers/gemini.ts` | New driver | New agent support |
| `src/drivers/registry.ts` | New — probe + route logic | Startup integration |
| `src/config.ts` | Add `agents`, change `models` → `roles` | Config schema |
| `src/commands/launch.ts` | Use `registry.resolveAgent()` + `driver.buildCommand()` instead of `buildClaudeCmd()` | Main coupling point |
| `src/commands/doctor.ts` | Probe all registered agents, report capabilities | Health check |
| `src/commands/init.ts` | Deploy generic role templates alongside claude ones | Setup |
| `scripts/spawn-workspace.sh` | Read agent + model from config, call driver | Shell-side routing |
| `orchestrator/*.CLAUDE.md` | Rename pattern, add generic variants | Role templates |

### Migration Path

1. Phase 1: Extract Claude driver from existing code, wire through registry — **zero behavior change**, just refactor
2. Phase 2: Add Codex + Gemini drivers, generic role templates
3. Phase 3: Semi-auto probe on startup, capability warnings in `cockpit doctor`
4. Phase 4: Per-project agent overrides, backward-compat config migration

## 7. What's NOT Changing

- **cmux** — stays as the workspace manager
- **Spoke vaults** — status files, learnings, wiki, handoffs all stay
- **Hub vault** — cross-project aggregation unchanged
- **CLI commands** — `cockpit launch`, `cockpit status`, `cockpit standup` unchanged
- **Default behavior** — everything defaults to Claude, existing users see zero difference
