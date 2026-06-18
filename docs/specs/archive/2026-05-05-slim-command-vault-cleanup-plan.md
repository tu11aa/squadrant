# Slim Command + Vault Discipline Cleanup — Implementation Plan

> **✅ Shipped** (PR #47, 2026-05-05). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Command optional (no auto-launch in `--all`, no no-arg shortcut, on-demand `cockpit command [--task ...]`), drop unenforceable "captain must write status" / "daily log" ceremony, and verify the compact-recovery doc line is in place.

**Architecture:** Add `cockpit command [--task briefing|learnings-review|wiki-aggregate]` — same split-pane primitive as `cockpit crew spawn`, but spawned off the *current* cmux workspace (no parent captain). The task flag picks one of three baked-in prompts. Strip command-launch from `cockpit launch --all` and from the no-arg `cockpit launch` path. Mark vault writes (status, daily log, handoff, wiki, learnings) as opt-in in `captain-ops` and `captain.claude.md`. Update README accordingly. Confirm decision-#8 compact-recovery line already present in `captain.claude.md`.

**Tech Stack:** TypeScript, commander.js, vitest (with `vi.hoisted` + `vi.mock`), Node 22, ES modules (imports end in `.js`), bash for shell shims.

**Spec:** `docs/specs/2026-05-05-cockpit-thin-redirect-design.md` (decisions #3, #4, #8).
**Issue:** [#42](https://github.com/tu11aa/claude-cockpit/issues/42) under umbrella [#40](https://github.com/tu11aa/claude-cockpit/issues/40).
**Branch:** `feature/slim-command-vault-cleanup` off `develop`.

---

## File Structure

**Create:**
- `src/commands/command.ts` — `cockpit command [--task ...]` CLI
- `src/commands/__tests__/command.test.ts` — unit tests for the CLI

**Modify:**
- `src/index.ts` — register `commandCommand`
- `src/commands/launch.ts` — drop command-launch from `--all` and from no-arg path
- `orchestrator/captain.claude.md` — verify compact-recovery line (decision #8) is present (it should already be)
- `plugin/skills/captain-ops/SKILL.md` — mark status/daily-log/handoff/wiki/learnings as opt-in
- `plugin/skills/command-ops/SKILL.md` — note "on-demand only; no persistent session"
- `orchestrator/command.claude.md` — note "on-demand only" usage
- `README.md` — drop command from default flow + How-It-Works diagram, add `cockpit command` row to commands table, update Knowledge System opt-in language

**No changes to:** crew templates, reactor template, daily-log skill body, wiki-ops skill, karpathy skill, runtime/workspace/tracker/notifier drivers, scripts/spawn-workspace.sh (umbrella tracks separately), `.gitignore`, `.claude/`.

---

## Task 1: Add `cockpit command` CLI (TDD)

**Files:**
- Create: `src/commands/command.ts`
- Create: `src/commands/__tests__/command.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/commands/__tests__/command.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const buildCommand = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe,
    list: vi.fn(),
    status: vi.fn(),
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane,
    closePane: vi.fn(),
    sendToPane,
    readPaneScreen: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    forProject() { return this.drivers.cmux; }
    global() { return this.drivers.cmux; }
    get(name: string) { return this.drivers[name]; }
    async probeAll() { return {}; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../../config.js", () => ({
  loadConfig,
  resolveHome: (p: string) => p,
}));

const claudeDriver = vi.hoisted(() => ({
  name: "claude",
  templateSuffix: "claude",
  probe: vi.fn(),
  buildCommand,
}));

vi.mock("../../drivers/index.js", () => ({
  createClaudeDriver: () => claudeDriver,
  createCodexDriver: () => ({ ...claudeDriver, name: "codex", templateSuffix: "generic" }),
  createGeminiDriver: () => ({ ...claudeDriver, name: "gemini", templateSuffix: "generic" }),
  createAiderDriver: () => ({ ...claudeDriver, name: "aider", templateSuffix: "generic" }),
  CapabilityRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    get(name: string) { return this.drivers[name]; }
  },
}));

import { runCommandSpawn } from "../command.js";

describe("cockpit command", () => {
  beforeEach(() => {
    newPane.mockReset();
    sendToPane.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
    execSyncMock.mockReset();
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {},
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    execSyncMock.mockReturnValue("workspace:42 something");
    newPane.mockResolvedValue({ workspaceId: "workspace:42", surfaceId: "surface:9" });
    buildCommand.mockReturnValue('claude --append-system-prompt-file /tmp/command.md "do briefing"');
  });

  it("spawns a split pane in the current cmux workspace with the briefing prompt", async () => {
    const result = await runCommandSpawn({ task: "briefing" });

    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("current-workspace"),
      expect.anything(),
    );
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:42",
      direction: "right",
    }));
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      role: "command",
      prompt: expect.stringMatching(/briefing/i),
    }));
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:42", surfaceId: "surface:9" },
      'claude --append-system-prompt-file /tmp/command.md "do briefing"',
    );
    expect(result).toEqual({ workspaceId: "workspace:42", surfaceId: "surface:9" });
  });

  it("uses learnings-review prompt when --task learnings-review", async () => {
    await runCommandSpawn({ task: "learnings-review" });

    const buildArgs = buildCommand.mock.calls[0][0];
    expect(buildArgs.prompt).toMatch(/learnings/i);
  });

  it("uses wiki-aggregate prompt when --task wiki-aggregate", async () => {
    await runCommandSpawn({ task: "wiki-aggregate" });

    const buildArgs = buildCommand.mock.calls[0][0];
    expect(buildArgs.prompt).toMatch(/wiki/i);
  });

  it("rejects unknown --task values", async () => {
    await expect(runCommandSpawn({ task: "bogus" as never }))
      .rejects.toThrow(/unknown task/i);
  });

  it("respects --agent override", async () => {
    await runCommandSpawn({ task: "briefing", agent: "codex" });

    expect(buildCommand).toHaveBeenCalled();
  });

  it("throws when current cmux workspace cannot be detected", async () => {
    execSyncMock.mockReturnValue("garbage");
    await expect(runCommandSpawn({ task: "briefing" }))
      .rejects.toThrow(/current cmux workspace/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/__tests__/command.test.ts`
Expected: FAIL — module `../command.js` not found.

- [ ] **Step 3: Implement `src/commands/command.ts`**

```typescript
import { Command } from "commander";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createAiderDriver,
  CapabilityRegistry,
} from "../drivers/index.js";
import type { PaneRef } from "../runtimes/types.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");
// TODO(runtime): current-workspace not yet abstracted by RuntimeDriver — direct cmux call retained.
const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

type CommandTask = "briefing" | "learnings-review" | "wiki-aggregate";

const TASK_PROMPTS: Record<CommandTask, string> = {
  briefing:
    "Run your daily briefing using the cockpit:command-ops skill. Read all spoke handoffs, yesterday's logs, current status; produce a concise cross-project briefing; save to {hubVault}/daily-logs/YYYY-MM-DD.md; then exit.",
  "learnings-review":
    "Run a learnings review using the cockpit:command-ops skill. Scan {spokeVault}/learnings across all projects, identify cross-project patterns, propose captured-skill or fix actions, and exit when done.",
  "wiki-aggregate":
    "Run a wiki aggregation pass using the cockpit:command-ops skill. Scan each spoke wiki index, identify shared knowledge worth promoting, write hub wiki pages, and exit when done.",
};

export interface CommandSpawnInput {
  task: CommandTask;
  direction?: "right" | "left" | "up" | "down";
  agent?: string;
}

function detectCurrentWorkspace(): string {
  const out = execSync(`"${CMUX_BIN}" current-workspace`, { encoding: "utf-8" }).trim();
  const match = out.match(/workspace:\d+/);
  if (!match) {
    throw new Error("Could not detect current cmux workspace. Run `cockpit command` from inside a cmux workspace.");
  }
  return match[0];
}

export async function runCommandSpawn(input: CommandSpawnInput): Promise<PaneRef> {
  const prompt = TASK_PROMPTS[input.task];
  if (!prompt) {
    throw new Error(`Unknown task '${input.task}'. Known: briefing, learnings-review, wiki-aggregate.`);
  }

  const config = loadConfig();
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).global(config);

  const workspaceId = detectCurrentWorkspace();

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    aider: createAiderDriver(),
  });
  const agentName = input.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, aider.`);
  }

  const promptFile = path.join(TEMPLATES_DIR, `command.${agent.templateSuffix}.md`);
  const cliCommand = agent.buildCommand({
    prompt,
    workdir: process.cwd(),
    role: "command",
    promptFile,
  });

  const direction = input.direction ?? "right";
  const title = `🤖 command-${input.task}`;
  const pane = await runtime.newPane({ workspaceId, direction, title });
  await runtime.sendToPane(pane, cliCommand);
  return pane;
}

export const commandCommand = new Command("command")
  .description("Spawn a one-shot Command session in a split pane (briefing | learnings-review | wiki-aggregate)")
  .option("--task <name>", "Task prompt to bake in (briefing|learnings-review|wiki-aggregate)", "briefing")
  .option("--direction <dir>", "Split direction (right|left|up|down)", "right")
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|aider)", "claude")
  .action(async (opts: { task: CommandTask; direction: "right" | "left" | "up" | "down"; agent: string }) => {
    try {
      const pane = await runCommandSpawn({ task: opts.task, direction: opts.direction, agent: opts.agent });
      console.log(chalk.green(`✔ Command spawned in ${pane.workspaceId} ${pane.surfaceId} (task: ${opts.task})`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/__tests__/command.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/command.ts src/commands/__tests__/command.test.ts
git commit -m "feat(command): add cockpit command CLI for one-shot tasks"
```

---

## Task 2: Wire `commandCommand` into the CLI root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register the new command**

Add the import next to the other command imports in `src/index.ts`:

```typescript
import { commandCommand } from "./commands/command.js";
```

And add the registration alongside the others (right after `program.addCommand(crewCommand);`):

```typescript
program.addCommand(commandCommand);
```

- [ ] **Step 2: Build + smoke-test help text**

Run: `npm run build && node dist/index.js command --help`
Expected: prints "Spawn a one-shot Command session in a split pane …" and the `--task`, `--direction`, `--agent` flags.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(command): register cockpit command in CLI root"
```

---

## Task 3: Drop command-launch from `cockpit launch --all` and no-arg path

**Files:**
- Modify: `src/commands/launch.ts`

- [ ] **Step 1: Update `--all` branch**

In `src/commands/launch.ts`, find the `if (opts.all)` block (around line 293). Replace it with:

```typescript
    if (opts.all) {
      // Launch reactor + all captains. Command is no longer auto-launched (#42).
      const hubPath = resolveHome(config.hubVault);
      fs.mkdirSync(hubPath, { recursive: true });

      console.log(chalk.bold("\nLaunching reactor + all captain workspaces\n"));

      const reactorName = "⚡ reactor";
      console.log(chalk.bold(`  Reactor: ${reactorName}`));
      await launchOne(reactorName, "reactor", hubPath, config.defaults.permissions?.reactor || "default", true, true);

      for (const [name, proj] of Object.entries(config.projects)) {
        const projPath = resolveHome(proj.path);
        const spokePath = resolveHome(proj.spokeVault);
        if (!fs.existsSync(spokePath)) {
          const spokeDriver = new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(name, config);
          await ensureSpokeLayout(spokeDriver);
          console.log(chalk.cyan(`  ✔ Created spoke vault at ${spokePath}`));
        }
        console.log(chalk.bold(`\n  Captain: ${proj.captainName} (${name})`));
        await launchOne(proj.captainName, "captain", projPath, config.defaults.permissions?.captain || "auto", false, true, name);
      }
      console.log("");
    }
```

- [ ] **Step 2: Update no-arg branch**

Replace the `else if (!project)` branch with an explicit error:

```typescript
    } else if (!project) {
      console.error(
        chalk.red(
          "\n  ✘ Specify a project name, or pass --all to launch reactor + every captain.\n" +
            "    For one-shot Command tasks, use `cockpit command --task <briefing|learnings-review|wiki-aggregate>`.\n",
        ),
      );
      process.exit(1);
    }
```

- [ ] **Step 3: Update the command description**

Change the `.description(...)` on `launchCommand` (around line 226) to:

```typescript
  .description(
    "Launch a project captain (with project arg) or reactor + all captains (--all). Use `cockpit command` for one-shot Command tasks.",
  )
```

- [ ] **Step 4: Update `--all` option help text**

Change the `--all` option help to:

```typescript
  .option("--all", "Launch reactor + all captain workspaces")
```

- [ ] **Step 5: Build + verify**

Run: `npm run build && node dist/index.js launch --help`
Expected: description and `--all` reflect the new behavior; no mention of "command workspace" in defaults.

- [ ] **Step 6: Commit**

```bash
git add src/commands/launch.ts
git commit -m "feat(launch): drop command-launch from --all and no-arg path (#42)"
```

---

## Task 4: Mark vault writes opt-in in `captain-ops` skill

**Files:**
- Modify: `plugin/skills/captain-ops/SKILL.md`

- [ ] **Step 1: Soften the startup status-write rule**

Find step 8 of "Session Startup":

````markdown
8. Write active status:
```bash
~/.config/cockpit/scripts/write-status.sh "{spokeVaultPath}" "captain_session" "active" "Captain session started"
```
````

Replace with:

````markdown
8. (Opt-in) Status writes are no longer required on every event. The reactor's auto-poller (#43) infers status from your pane content. Only run `~/.config/cockpit/scripts/write-status.sh` when you have a meaningful note worth recording (a blocker, a deliberate "starting work on X", etc.) — not on a schedule.
````

- [ ] **Step 2: Reframe "Session Shutdown — Write Handoff" as opt-in**

Find the heading `## Session Shutdown — Write Handoff` and replace its body (down to but not including `## Group Awareness`) with:

````markdown
## Session Shutdown (Opt-In Writes)

End-of-session writes are **opt-in**, not on a schedule. Only write what is meaningful:

1. **Daily log (opt-in):** if you accomplished something worth a daily log, use the `cockpit:daily-log` skill. Skip it if today was uneventful.
2. **Wiki promotion (opt-in):** if a learning crystallized into reusable knowledge, promote to a wiki page using `cockpit:wiki-ops`. Otherwise skip.
3. **Handoff (opt-in but recommended for in-flight work):** if work is mid-flight, write a handoff so tomorrow's session can resume:

```bash
~/.config/cockpit/scripts/write-handoff.sh "{spokeVaultPath}" '{
  "currentState": "Brief description of where things stand",
  "openBranches": ["feat/branch-name — what it contains"],
  "nextSteps": ["First thing to do tomorrow", "Second thing"],
  "blockedItems": ["Any unresolved blockers"],
  "decisions": ["Key decisions made this session that should not be revisited"],
  "activeTasks": "Summary of task progress (e.g., 3/7 done)"
}'
```

If everything is shipped and there is no in-flight work, you do not need to write a handoff.

4. (Optional) The reactor's auto-poller updates `status.md` from your pane buffer; you do not need to manually write a "session ended" status.

5. (Optional) If a Command session is running and you want to notify it:
   ```bash
   cockpit runtime send --command "Captain {project} ending session — handoff written."
   ```
   Skip this entirely if no Command session is up — Command is on-demand now.

**The handoff is your gift to tomorrow's session.** Be specific. "Working on the API" is useless. "Backend routes for /providers and /providers/:id are done, /timeseries endpoint is next, PR #12 is open for review" is useful.
````

- [ ] **Step 3: Soften "Wiki Compilation" framing**

Find the `## Wiki Compilation` section. Replace its lead-in paragraph (the lines before the numbered list) with:

```markdown
Wiki writes are **opt-in**. Compile knowledge when you have something worth recording — not on a schedule. Use the `cockpit:wiki-ops` skill for full instructions.
```

Leave the numbered points (when to write a wiki page, querying, the learnings/wiki distinction) unchanged.

- [ ] **Step 4: Soften "Recording Learnings" framing**

Find the `## Recording Learnings` heading and prepend a single line:

```markdown
Recording learnings is **opt-in**. Record when something genuinely surprised you or a useful pattern emerged — not on a schedule.
```

Leave the existing script invocation and category list unchanged.

- [ ] **Step 5: Verify**

Run: `git diff plugin/skills/captain-ops/SKILL.md` and read it end-to-end. Confirm: no remaining wording that says "always write status after every event", "write a daily log at end of day" framed as required, or implies handoff/wiki/learnings are mandatory each session.

- [ ] **Step 6: Commit**

```bash
git add plugin/skills/captain-ops/SKILL.md
git commit -m "docs(captain-ops): mark vault writes opt-in (#42)"
```

---

## Task 5: Update `command-ops` skill — on-demand framing

**Files:**
- Modify: `plugin/skills/command-ops/SKILL.md`

- [ ] **Step 1: Update the description frontmatter**

Replace the existing `description:` line in the frontmatter with:

```yaml
description: Command playbook — invoked on-demand by `cockpit command [--task ...]`. Covers daily briefing, delegation workflow, project registration, status checking, and learnings review. Command is no longer always-on.
```

- [ ] **Step 2: Add an on-demand banner under the H1**

Right after the `# Command Operations` heading, insert:

```markdown
> **On-demand only.** Command is no longer launched by `cockpit launch --all`. You were spawned by `cockpit command --task <briefing|learnings-review|wiki-aggregate>` to run a single task and exit. Do the task, then exit cleanly — no persistent loop.
```

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/command-ops/SKILL.md
git commit -m "docs(command-ops): mark command session as on-demand (#42)"
```

---

## Task 6: Update `command.claude.md` template — on-demand framing

**Files:**
- Modify: `orchestrator/command.claude.md`

- [ ] **Step 1: Insert an on-demand line under the H1**

Right after the line `You are the **command center** for claude-cockpit. ...`, insert:

```markdown
You are spawned **on-demand** by `cockpit command [--task ...]` for a single task. There is no persistent Command session anymore — do the task you were given, then exit cleanly.
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/command.claude.md
git commit -m "docs(command): mark template as on-demand (#42)"
```

---

## Task 7: Verify decision-#8 compact-recovery line is in `captain.claude.md`

**Files:**
- Inspect (only): `orchestrator/captain.claude.md`

- [ ] **Step 1: Grep for the line**

Run:
```bash
grep -n "Compact recovery\|/compact" orchestrator/captain.claude.md
```
Expected: matches the existing line `4. **Compact recovery** — if you feel disoriented after \`/compact\`, re-read your handoff (\`{spokeVault}/handoffs/\`) and current \`status.md\` to restore work context. Role itself survives compact via \`--append-system-prompt-file\`.`

- [ ] **Step 2: If absent, add it**

If grep found nothing, append the line as Core Rule 4 (matching the wording in decision #8 of `2026-05-05-cockpit-thin-redirect-design.md`). If already present, no change is needed — note "already present from #41" in your task tracker. **No commit if no change.**

---

## Task 8: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update "How It Works" diagram**

Find the fenced block under `## How It Works` (the one that begins with `cockpit launch → Command session ...`). Replace it with:

```
cockpit launch <project>          → Captain (per project, in cmux)
cockpit launch --all              → Reactor + every Captain
cockpit command --task briefing   → One-shot Command session in a split pane
                                       (also: --task learnings-review | wiki-aggregate)
Captain → cockpit crew spawn …    → Crew (split pane, fresh agent CLI session)
```

And replace the ordered-list immediately below with:

```markdown
1. **`cockpit init`** — first-time setup
2. **`cockpit launch <project>`** — start the project's captain in cmux
3. **`cockpit launch --all`** — start the reactor and every captain at once
4. **`cockpit command --task briefing`** — on-demand Command session for cross-project work (optional; spawns in a split pane and exits when done)
5. **`cockpit status`** — quick status check without spawning anything
```

- [ ] **Step 2: Update the commands table**

In the commands table, replace the existing `cockpit launch` and `cockpit launch --all` rows with:

```markdown
| `cockpit launch <project>` | Start a specific project captain |
| `cockpit launch --all` | Launch reactor + all captain workspaces |
```

(Drop the `cockpit launch` row that says "Start the command workspace".)

Add a new row right after the `cockpit launch --all` row:

```markdown
| `cockpit command [--task <briefing\|learnings-review\|wiki-aggregate>] [--agent <a>]` | Spawn a one-shot Command session in a split pane (no persistent Command). |
```

- [ ] **Step 3: Update the Roles section**

Replace the **Command** bullet with:

```markdown
- **Command** (Opus) — *on-demand* cross-project session. Spawned by `cockpit command --task <briefing|learnings-review|wiki-aggregate>` in a split pane; exits when the task completes. No persistent Command process.
```

- [ ] **Step 4: Update Knowledge System framing to opt-in**

Replace the `### Knowledge System` block with:

```markdown
### Knowledge System (opt-in writes)

- **Status** — auto-derived by the reactor's poller from each captain's pane buffer (#43). Captains do not write status on every event.
- **Handoff files** — captain writes when in-flight work needs to survive into tomorrow; skipped on uneventful sessions.
- **Daily logs** — captain writes when the day produced something worth a log; not on a schedule.
- **Learnings** — recorded when a captain encounters a genuinely surprising or reusable pattern.
- **Wiki** — compiled, indexed knowledge pages in spoke vaults (`wiki/pages/`); promoted from learnings when worth maintaining.
- **Hub Wiki** — cross-project knowledge aggregated by an on-demand `cockpit command --task wiki-aggregate` run.
- Scripts: `wiki-ingest.sh`, `wiki-query.sh`, `wiki-log.sh`.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document slim command + opt-in vault writes (#42)"
```

---

## Task 9: Full-suite verification + PR

- [ ] **Step 1: Build clean**

Run: `npm run build`
Expected: exit 0, no tsc errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass (excluding the 2 known pre-existing emoji-related `commandName` failures in `src/config.test.ts` — unrelated to #42).

- [ ] **Step 3: Re-link cockpit and smoke-test**

Run:
```bash
npm link
cockpit command --help          # shows --task, --direction, --agent
cockpit launch --help           # description no longer mentions "command workspace"
cockpit launch                  # exits 1 with the new "specify a project or --all" message
```

If you have a registered project and you are inside a cmux workspace, also smoke-test a real spawn:
```bash
cockpit command --task briefing
```
Expected: `✔ Command spawned in workspace:N surface:M (task: briefing)`. Visually verify the new pane opens with a Claude session running the briefing prompt; close the pane when satisfied.

- [ ] **Step 4: Audit — no new direct cmux invocations outside sanctioned places**

Run:
```bash
git grep -nE '/Applications/cmux\.app/Contents/Resources/bin/cmux' -- 'src/' 'plugin/' 'orchestrator/'
```
Expected: only the existing hits in `src/runtimes/cmux.ts`, `src/commands/launch.ts`, `src/commands/command.ts` (the new TODO-flagged `current-workspace` call). No new hits in skill/template files.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feature/slim-command-vault-cleanup
gh pr create --base develop --title "Slim Command + vault discipline cleanup (#42)" --body "$(cat <<'EOF'
Closes #42 (under umbrella #40).

## Summary

Three bundled changes that all "remove ceremony, add minimal docs":

- **A — Slim Command:** `cockpit launch --all` no longer auto-spawns a Command session; bare `cockpit launch` no longer defaults to Command. New `cockpit command [--task briefing|learnings-review|wiki-aggregate]` spawns a one-shot session in a split pane.
- **E — Vault discipline cleanup:** removed "always write status after every event" and "daily log at end of day" rules from `captain-ops`; handoff / wiki / learnings are now explicitly opt-in.
- **F — Compact disorient doc line:** verified the line added by #41 is present in `captain.claude.md`. (No new commit if already there.)

`command.claude.md` and `command-ops` skill are kept but reframed as on-demand.

## Test plan

- [x] Unit tests for `cockpit command` (default task, each --task, unknown task, --agent override, no-cmux-workspace error)
- [x] Build + smoke-test of `cockpit command --help` and the new `cockpit launch` no-arg behaviour
- [x] Manual smoke of `cockpit command --task briefing` against a live cmux workspace
- [x] No new direct cmux binary calls outside `src/runtimes/cmux.ts`, `src/commands/launch.ts`, `src/commands/command.ts`
EOF
)"
```

- [ ] **Step 6: Verify CI is green and request review** (or self-review for solo).

---

## Self-Review Checklist

Before declaring this plan complete, verify:

1. **Spec coverage** — every checkbox in #42 is covered:
   - **A — Slim Command**
     - [x] `cockpit launch --all` no longer launches Command (Task 3)
     - [x] no-arg `cockpit launch` no longer defaults to Command (Task 3)
     - [x] `cockpit command [--task ...]` exists (Task 1, 2)
     - [x] `command.claude.md` + `command-ops` kept and reframed on-demand (Task 5, 6)
     - [x] README — command removed from default flow, `cockpit command` in commands table (Task 8)
     - [x] `captain.claude.md` — no "report to command" requirement (already absent from #41 rewrite; verify in Task 7 grep)
   - **E — Vault discipline cleanup**
     - [x] "always write status" removed (Task 4)
     - [x] "daily log at end of day" requirement removed (Task 4)
     - [x] handoff / wiki / learnings explicitly opt-in (Task 4)
     - [x] README knowledge-system reflects opt-in (Task 8)
   - **F — Compact disorient doc line**
     - [x] line present in `captain.claude.md` (verified Task 7; should already be present from #41)

2. **No drive-by refactoring** — Karpathy principles: every changed line traces to a checkbox in #42. The cmux references in `scripts/spawn-workspace.sh`, `src/commands/launch.ts` (`select-workspace`/`current-workspace`), `command-ops` (the captain-discovery commands), and `reactor-ops` are intentionally NOT touched — they belong to a separate cleanup tracked under the umbrella.

3. **All new code has tests** — `cockpit command` is fully covered by `command.test.ts`.

4. **Opt-in language is consistent** — `captain-ops`, `command-ops`, README, and templates all use the same "opt-in / on-demand" phrasing.

If any task ships with placeholder content or unexpected scope creep, open a follow-up issue rather than expanding this PR.
