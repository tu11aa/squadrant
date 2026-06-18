# Plugin System Phase 4 — Notifier Slot Implementation Plan

> **✅ Shipped** (PR #29, 2026-04-21). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abstract user-notification behind a `NotifierDriver` interface mirroring phases 1-3; ship `CmuxNotifier` that delegates to `cockpit runtime send --command`; expose `cockpit notify` CLI; migrate 3 escalation call-sites in `execute-reaction.sh`.

**Architecture:** New `src/notifiers/` parallel to `src/runtimes/`, `src/workspaces/`, `src/trackers/`. `CmuxNotifier` uses `execSync` to call `cockpit runtime send --command "$MSG"`. Global scope (no per-project); single-op interface (`notify`).

**Tech Stack:** TypeScript, commander.js, vitest, Node 22 (`child_process`), bash.

**Spec:** `docs/specs/2026-04-21-plugin-system-notifier-design.md`

---

## File Structure

**Create:**
- `src/notifiers/types.ts` — `NotifierDriver`, `NotifierProbeResult`, `NotifierScope`, `NotifierFactory`
- `src/notifiers/cmux.ts` — `createCmuxNotifier(scope)`
- `src/notifiers/registry.ts` — `NotifierRegistry`
- `src/notifiers/index.ts` — barrel
- `src/notifiers/__tests__/cmux.test.ts`
- `src/notifiers/__tests__/registry.test.ts`
- `src/notifiers/__tests__/helpers/memory-notifier.ts` + `.test.ts`
- `src/commands/notify.ts` — `cockpit notify` CLI

**Modify:**
- `src/config.ts` — add `notifier?: string` to `CockpitConfig` (no per-project field)
- `src/index.ts` — register `notifyCommand`
- `src/commands/doctor.ts` — probe configured notifier
- `scripts/execute-reaction.sh` — 3 escalation call-sites → `cockpit notify`
- `README.md` — document `notifier` config + CLI

---

## Task 1: Add `notifier?` field to CockpitConfig

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add `notifier?: string` to `CockpitConfig`**

In `src/config.ts`, add `notifier?: string` to `CockpitConfig` right after the existing `tracker?: string` field. Do NOT add to `ProjectConfig` (notifier is global).

```typescript
export interface CockpitConfig {
  commandName: string;
  hubVault: string;
  projects: Record<string, ProjectConfig>;
  agents?: Record<string, AgentEntry>;
  runtime?: string;
  workspace?: string;
  tracker?: string;
  notifier?: string;  // NEW — global default ("cmux" when absent); no per-project
  defaults: {
    maxCrew: number;
    worktreeDir: string;
    teammateMode: string;
    permissions: PermissionConfig;
    models?: ModelRoutingConfig;
    roles?: RoleConfig;
  };
  metrics: {
    enabled: boolean;
    path: string;
  };
}
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(notifier): add optional notifier field to CockpitConfig"
```

---

## Task 2: Define NotifierDriver interface

**Files:**
- Create: `src/notifiers/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/notifiers/` directory. Write `src/notifiers/types.ts`:

```typescript
export interface NotifierProbeResult {
  installed: boolean;
  reachable: boolean;
}

export interface NotifierScope {
  [key: string]: unknown;
}

export interface NotifierDriver {
  name: string;

  probe(): Promise<NotifierProbeResult>;
  notify(message: string): Promise<void>;
}

export type NotifierFactory = (scope: NotifierScope) => NotifierDriver;
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/notifiers/types.ts
git commit -m "feat(notifier): add NotifierDriver interface"
```

---

## Task 3: Write failing tests for CmuxNotifier

**Files:**
- Create: `src/notifiers/__tests__/cmux.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/notifiers/__tests__/cmux.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCmuxNotifier } from "../cmux.js";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execSync: execMock,
}));

describe("CmuxNotifier", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("has name 'cmux'", () => {
    expect(createCmuxNotifier({}).name).toBe("cmux");
  });

  it("notify shells out to 'cockpit runtime send --command'", async () => {
    execMock.mockReturnValue("");
    await createCmuxNotifier({}).notify("hello world");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain("cockpit runtime send");
    expect(calls[0]).toContain("--command");
    expect(calls[0]).toContain("hello world");
  });

  it("notify escapes double-quotes in the message", async () => {
    execMock.mockReturnValue("");
    await createCmuxNotifier({}).notify('say "hi"');
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain('\\"hi\\"');
  });

  it("notify throws when cockpit runtime send fails", async () => {
    execMock.mockImplementation(() => { throw new Error("send failed"); });
    await expect(createCmuxNotifier({}).notify("x")).rejects.toThrow(/send failed/);
  });

  it("probe returns installed+reachable=true when status succeeds (exit 0)", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("cockpit runtime status --command")) return "running";
      return "";
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(true);
    expect(probe.reachable).toBe(true);
  });

  it("probe returns reachable=false when status throws (non-zero exit)", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("cockpit runtime status --command")) {
        const err: Error & { status?: number } = new Error("stopped");
        err.status = 1;
        throw err;
      }
      return "";
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(true);
    expect(probe.reachable).toBe(false);
  });

  it("probe returns installed=false when cockpit binary is missing", async () => {
    execMock.mockImplementation(() => {
      const err: Error & { code?: string } = new Error("cockpit: command not found");
      err.code = "ENOENT";
      throw err;
    });
    const probe = await createCmuxNotifier({}).probe();
    expect(probe.installed).toBe(false);
    expect(probe.reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/notifiers/__tests__/cmux.test.ts`
Expected: FAIL with "Cannot find module '../cmux.js'"

---

## Task 4: Implement CmuxNotifier

**Files:**
- Create: `src/notifiers/cmux.ts`

- [ ] **Step 1: Write the implementation**

Create `src/notifiers/cmux.ts`:

```typescript
import { execSync } from "node:child_process";
import type {
  NotifierDriver,
  NotifierProbeResult,
  NotifierScope,
} from "./types.js";

function escape(s: string): string {
  return s.replace(/"/g, '\\"');
}

export function createCmuxNotifier(_scope: NotifierScope): NotifierDriver {
  return {
    name: "cmux",

    async probe(): Promise<NotifierProbeResult> {
      try {
        execSync("cockpit runtime status --command", { encoding: "utf-8", stdio: "pipe" });
        return { installed: true, reachable: true };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          return { installed: false, reachable: false };
        }
        // Non-zero exit = cockpit binary works but command workspace not running
        return { installed: true, reachable: false };
      }
    },

    async notify(message: string): Promise<void> {
      execSync(`cockpit runtime send --command "${escape(message)}"`, { encoding: "utf-8" });
    },
  };
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/notifiers/__tests__/cmux.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 3: Commit**

```bash
git add src/notifiers/cmux.ts src/notifiers/__tests__/cmux.test.ts
git commit -m "feat(notifier): add CmuxNotifier (delegates to cockpit runtime send)"
```

---

## Task 5: NotifierRegistry TDD

**Files:**
- Create: `src/notifiers/__tests__/registry.test.ts`
- Create: `src/notifiers/registry.ts`

- [ ] **Step 1: Write failing tests**

Create `src/notifiers/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { NotifierRegistry } from "../registry.js";
import type { NotifierDriver, NotifierScope } from "../types.js";
import type { CockpitConfig } from "../../config.js";

function stubFactory(name: string): (scope: NotifierScope) => NotifierDriver {
  return (_scope) => ({
    name,
    probe: vi.fn(async () => ({ installed: true, reachable: true })),
    notify: vi.fn(async () => {}),
  });
}

function baseConfig(overrides: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "cmd",
    hubVault: "~/hub",
    projects: {},
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "default", captain: "acceptEdits" },
    },
    metrics: { enabled: false, path: "" },
    ...overrides,
  };
}

describe("NotifierRegistry", () => {
  it("returns cmux driver by default", () => {
    const registry = new NotifierRegistry({ cmux: stubFactory("cmux") });
    expect(registry.get(baseConfig()).name).toBe("cmux");
  });

  it("uses config.notifier override", () => {
    const registry = new NotifierRegistry({
      cmux: stubFactory("cmux"),
      slack: stubFactory("slack"),
    });
    expect(registry.get(baseConfig({ notifier: "slack" })).name).toBe("slack");
  });

  it("throws when configured provider has no factory", () => {
    const registry = new NotifierRegistry({ cmux: stubFactory("cmux") });
    expect(() => registry.get(baseConfig({ notifier: "unknown" }))).toThrowError(/unknown/i);
  });

  it("probeAll returns results keyed by provider name", async () => {
    const registry = new NotifierRegistry({
      cmux: stubFactory("cmux"),
      slack: stubFactory("slack"),
    });
    const results = await registry.probeAll();
    expect(results.cmux.installed).toBe(true);
    expect(results.slack.installed).toBe(true);
  });
});
```

Verify failing: `npx vitest run src/notifiers/__tests__/registry.test.ts`
Expected: "Cannot find module '../registry.js'"

- [ ] **Step 2: Implement registry**

Create `src/notifiers/registry.ts`:

```typescript
import type { CockpitConfig } from "../config.js";
import type {
  NotifierDriver,
  NotifierFactory,
  NotifierProbeResult,
} from "./types.js";

const DEFAULT_NOTIFIER = "cmux";

export class NotifierRegistry {
  constructor(private factories: Record<string, NotifierFactory>) {}

  get(config: CockpitConfig): NotifierDriver {
    const name = config.notifier ?? DEFAULT_NOTIFIER;
    return this.getFactory(name)({});
  }

  getFactory(name: string): NotifierFactory {
    const factory = this.factories[name];
    if (!factory) {
      throw new Error(`Unknown notifier provider '${name}' — no factory registered`);
    }
    return factory;
  }

  async probeAll(): Promise<Record<string, NotifierProbeResult>> {
    const results: Record<string, NotifierProbeResult> = {};
    for (const [name, factory] of Object.entries(this.factories)) {
      try {
        results[name] = await factory({}).probe();
      } catch {
        results[name] = { installed: false, reachable: false };
      }
    }
    return results;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/notifiers/__tests__/registry.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 4: Commit**

```bash
git add src/notifiers/registry.ts src/notifiers/__tests__/registry.test.ts
git commit -m "feat(notifier): add NotifierRegistry"
```

---

## Task 6: Barrel + in-memory helper

**Files:**
- Create: `src/notifiers/index.ts`
- Create: `src/notifiers/__tests__/helpers/memory-notifier.ts`
- Create: `src/notifiers/__tests__/helpers/memory-notifier.test.ts`

- [ ] **Step 1: Write barrel**

Create `src/notifiers/index.ts`:

```typescript
export { createCmuxNotifier } from "./cmux.js";
export { NotifierRegistry } from "./registry.js";
export type {
  NotifierDriver,
  NotifierFactory,
  NotifierProbeResult,
  NotifierScope,
} from "./types.js";
```

- [ ] **Step 2: Write in-memory helper**

Create `src/notifiers/__tests__/helpers/memory-notifier.ts`:

```typescript
import type { NotifierDriver } from "../../types.js";

export function createMemoryNotifier(): NotifierDriver & {
  messages: string[];
} {
  const messages: string[] = [];
  return {
    name: "memory",
    messages,
    async probe() {
      return { installed: true, reachable: true };
    },
    async notify(message: string) {
      messages.push(message);
    },
  };
}
```

- [ ] **Step 3: Write smoke test**

Create `src/notifiers/__tests__/helpers/memory-notifier.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryNotifier } from "./memory-notifier.js";

describe("createMemoryNotifier", () => {
  it("records notified messages in order", async () => {
    const n = createMemoryNotifier();
    await n.notify("first");
    await n.notify("second");
    expect(n.messages).toEqual(["first", "second"]);
  });

  it("probe returns installed+reachable=true", async () => {
    const n = createMemoryNotifier();
    expect(await n.probe()).toEqual({ installed: true, reachable: true });
  });
});
```

- [ ] **Step 4: Verify build + tests**

Run: `npm run build && npx vitest run src/notifiers/__tests__/helpers/`
Expected: build exits 0, tests 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/notifiers/index.ts src/notifiers/__tests__/helpers/
git commit -m "feat(notifier): add barrel and in-memory test notifier"
```

---

## Task 7: `cockpit notify` CLI subcommand

**Files:**
- Create: `src/commands/notify.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the command file**

Create `src/commands/notify.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxNotifier, NotifierRegistry } from "../notifiers/index.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const notifyCommand = new Command("notify")
  .description("Send a message to the user via the configured notifier")
  .argument("<message>", "Message to send (use '-' to read from stdin)")
  .action(async (message: string) => {
    const config = loadConfig();
    const registry = new NotifierRegistry({ cmux: createCmuxNotifier });
    try {
      const payload = message === "-" ? await readStdin() : message;
      if (!payload) throw new Error("Empty message");
      await registry.get(config).notify(payload);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Register in src/index.ts**

Add import after `trackerCommand`:

```typescript
import { notifyCommand } from "./commands/notify.js";
```

And register after `program.addCommand(trackerCommand);`:

```typescript
program.addCommand(notifyCommand);
```

- [ ] **Step 3: Build and smoke**

Run:
```
npm run build
node dist/index.js notify --help
```
Expected: shows help for notify, single positional arg.

- [ ] **Step 4: Commit**

```bash
git add src/commands/notify.ts src/index.ts
git commit -m "feat(notifier): add 'cockpit notify' CLI subcommand"
```

---

## Task 8: Migrate execute-reaction.sh escalations

**Files:**
- Modify: `scripts/execute-reaction.sh`

- [ ] **Step 1: Read the file and identify the 3 call-sites**

Run: `grep -n "cockpit runtime send --command" scripts/execute-reaction.sh`

Expected: 3 matches in the `escalate`, `send-to-command`, and `auto-fix-ci` (max-retries) cases.

- [ ] **Step 2: Replace each occurrence**

For EACH match, replace:
```bash
cockpit runtime send --command "$MESSAGE"
```
with:
```bash
cockpit notify "$MESSAGE"
```

(Variable names may differ — `$ESC_MSG`, `$MSG`, etc. Use the same variable the original call used.)

Do NOT modify any `cockpit runtime send "$PROJECT" "$MESSAGE"` calls — those dispatch to project captains, not notifications.

Also remove any surrounding `if get_command_ws >/dev/null; then ...; fi` guards — `cockpit notify` handles offline-command gracefully (exits non-zero, caller already checks).

Example transformation for the `escalate` case:

Before:
```bash
escalate)
  if get_command_ws >/dev/null && cockpit runtime send --command "$MESSAGE"; then
    echo "✔ Escalated to command: ${RULE}"
  else
    echo "⚠️  Command workspace offline. Escalation: ${MESSAGE}"
  fi
  ;;
```

After:
```bash
escalate)
  if cockpit notify "$MESSAGE"; then
    echo "✔ Escalated to command: ${RULE}"
  else
    echo "⚠️  Command workspace offline. Escalation: ${MESSAGE}"
  fi
  ;;
```

Apply the same transformation to `send-to-command` and the `auto-fix-ci` max-retries escalation block.

- [ ] **Step 3: Verify**

Run:
```bash
bash -n scripts/execute-reaction.sh
```
Expected: no output, exit 0.

Run: `grep -c "cockpit runtime send --command" scripts/execute-reaction.sh`
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/execute-reaction.sh
git commit -m "refactor(reactor): migrate escalations to 'cockpit notify'"
```

---

## Task 9: Doctor probe + README

**Files:**
- Modify: `src/commands/doctor.ts`
- Modify: `README.md`

- [ ] **Step 1: Add doctor probe**

In `src/commands/doctor.ts`, add import at the top:

```typescript
import { createCmuxNotifier, NotifierRegistry } from "../notifiers/index.js";
```

Inside the action, after the tracker probe block, add:

```typescript
// Probe notifier providers
const notifiers = new NotifierRegistry({ cmux: createCmuxNotifier });
const notifierProbes = await notifiers.probeAll();
for (const [name, probe] of Object.entries(notifierProbes)) {
  results.push(check(
    `Notifier '${name}' installed`,
    probe.installed,
  ));
  if (probe.installed) {
    results.push(check(
      `Notifier '${name}' reachable`,
      probe.reachable,
    ));
  }
}
```

- [ ] **Step 2: Update README**

In `README.md`:

**2a.** After the existing `cockpit tracker get-checks` row in the Commands table, add:

```markdown
| `cockpit notify <message>` | Send a message to the user via the configured notifier |
```

**2b.** In the Config JSON example, add at top level (after `"tracker": "github",`):

```json
  "notifier": "cmux",
```

**2c.** After the `### Tracker Abstraction` subsection, add:

```markdown
### Notifier Abstraction

User-facing notifications run behind a pluggable **notifier driver** (currently only `cmux`). Escalations, reactor alerts, and other "tell the user" events go through `cockpit notify <message>`. The default `CmuxNotifier` delegates to `cockpit runtime send --command` — the abstraction exists as a swap-point for future Slack/Discord/email/pager drivers. Notifier is global (no per-project override). See `docs/specs/2026-04-21-plugin-system-notifier-design.md`.
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build && node dist/index.js doctor`
Expected: new `Notifier 'cmux' installed` + `Notifier 'cmux' reachable` lines.

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts README.md
git commit -m "feat(notifier): doctor probe + README docs"
```

---

## Task 10: Full-suite verification

**Files:** none.

- [ ] **Step 1: Test suite**

Run: `npm run test -- --run`
Expected: all new notifier tests pass (~13 total); baseline preserved.

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: exits 0 on both.

- [ ] **Step 3: CLI smoke**

Run:
- `node dist/index.js notify --help` — shows help
- `node dist/index.js doctor` — shows Notifier checks
- `echo "test" | node dist/index.js notify -` — reads stdin (if command workspace running, delivers; else fails gracefully)

- [ ] **Step 4: No commit — verification only**

---

## Self-Review Notes

- **Spec coverage:** §1 Interface → T2; §2 Registry + Config → T1, T5; §3 CLI → T7; §4 Refactor → T8, T9 (README + doctor); §5 Testing → T3, T5, T6.
- **Type consistency:** `NotifierDriver` methods (`probe`, `notify`) identical across types, cmux.ts, memory-notifier, registry tests, CLI.
- **Deferred scope** (per spec §Non-Goals): no urgency levels, no multi-sink routing, no per-project notifier, no additional providers.
- **Commit discipline:** 9 atomic commits across 10 tasks (Task 10 is verify-only).
