<!-- squadrant:start -->

## Project Direction: Multi-Agent

Squadrant is a **multi-agent orchestration layer**, not a Claude-Code-only tool. Claude Code is the reference implementation today; Codex, Cursor, and Gemini CLI are supported (or in progress) through the runtime driver abstraction and the upcoming cross-agent projection layer (issue #31).

When working on squadrant:
- Prefer **`AGENTS.md`** as the canonical instruction format. `CLAUDE.md` is becoming a thin wrapper.
- When adding agent-facing features, ask: *"does this work for non-Claude agents too?"* If not, file a follow-up issue to generalize it.
- Don't add Claude-only surface area without a migration path. The three plugin slots (runtime / workspace / notifier) exist specifically to avoid this.
- Skills in `plugin/skills/` are portable markdown — Claude Code reads them via the Skill tool; other agents read them via `AGENTS.md` inclusion.

Full direction statement: [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## Repository layout

Six packages in a one-way DAG: `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`

| Package | Owns |
|---|---|
| `@squadrant/shared` | Config schema, types, constants — leaf, zero internal deps |
| `@squadrant/core` | Daemon, state-machine, protocol, `AgentDriver` interface |
| `@squadrant/agents` | AI driver seam: claude / codex / opencode / gemini |
| `@squadrant/workspaces` | Runtime (cmux), workspace (obsidian), notifier drivers |
| `@squadrant/web` | Observability dashboard (bundled HTML/JS) |
| `@squadrant/cli` | Commands, bin entry, daemon host — root package |

Build outputs: `dist/index.js` (CLI bin) · `dist/squadrantd.js` (daemon). See [architecture diagram](docs/diagrams/2026-08-22-squadrant-architecture.html).

## Telegram (opt-in, #65)

Two-way Telegram lives in `@squadrant/core` (`src/telegram/*`: `client`/`format`/`state`/`bridge`/`setup`) and is wired into the daemon by the CLI host (`squadrantd.ts`) — a daemon-internal `TelegramBridge`, **not** a separate process. Outbound crew lifecycle events push to a per-project forum topic; inbound replies become a `captain.message` mailbox entry delivered to the captain pane. It is constructed only when `config.telegram` is present (zero behavior change otherwise) and uses plain `fetch` — no runtime SDK (`@grammyjs/types` is a dev-only type dep). Set up via `squadrant telegram setup` (interactive wizard) then `squadrant telegram link <project>` / `squadrant telegram status`; full guide + config block in [docs/reference.md](docs/reference.md#telegram-two-way-opt-in).

**⚠️ Security gap (v1):** chat membership implies captain control — anyone who can post in the linked supergroup can steer the captain. Inbound is filtered only by a `chat_id` allowlist; a per-user-id allowlist is deferred to [#321](https://github.com/tu11aa/squadrant/issues/321). Inbound text is always data (a captain message), never an executed command.

## Managed `~/.claude/settings.json` (#615)

squadrant owns and reconciles `~/.claude/settings.json` via `installClaudeHooks` (`packages/workspaces/src/native-hooks/native-hook-source.ts`), called by `NativeHookSource.install()` on every daemon boot. It is idempotent and non-clobbering — unrelated top-level fields and non-squadrant hook entries (yours, cmux's, etc.) are always preserved.

- **Hooks — always verified + repaired, unconditional.** The full squadrant-owned hook set (`SessionStart` / `UserPromptSubmit` / `PreToolUse` incl. the `AskUserQuestion` tool matcher / `Stop` / `Notification` / `SessionEnd`) is checked on every run. A missing hook is repaired and a one-line warning is logged. The `AskUserQuestion` → `squadrant hooks claude ask-question` mapping is what makes crew-blocked signalling work (#560); a machine that never had it — or had it clobbered — used to lose blocked-signalling silently. It no longer does.
- **`env` overlay — opt-in only, `defaults.claudeEnv`.** Set `defaults.claudeEnv` in `~/.config/squadrant/config.json` to deep-merge extra keys into settings.json's `env` block. Absent ⇒ nothing is written to `env`. The merge is non-clobbering: a key already present with a different value is never overwritten, just logged.

  ```json
  { "defaults": { "claudeEnv": { "CLAUDE_AFK_TIMEOUT_MS": "240000", "CLAUDE_AFK_COUNTDOWN_MS": "30000" } } }
  ```

  Motivating example: Claude Code's AFK auto-continue mode (`CLAUDE_AFK_TIMEOUT_MS` / `CLAUDE_AFK_COUNTDOWN_MS`) auto-resolves prompts after an idle timeout — the same risk class as auto-answering approval prompts while unattended (#484/#516). squadrant does **not** enable this by default for anyone; it's opt-in per machine only, via `claudeEnv`.

## Captain/Control Channel (#667)

Squadrant is replacing screen-scraped liveness/delivery inference with native agent control APIs as ground truth. Lives in `@squadrant/core` (`src/captain-channel.ts`, `src/control-channel.ts`, `src/lifecycle-source.ts`), fed by the 3 `LifecycleSource` implementations (`CmuxStore`, `NativeHook`, `CodexAppServer` — #333) that already replaced the old title-sweep liveness model.

- **`controlChannel`** — per-agent-type setting (`off` / `shadow` / `on`). `claude` is cut over to `on`: delivery verdicts for crew turns come from an agent receipt, not pane-scraping. `opencode` remains the unproven branch — it still misfires and is left off/shadow. `off → shadow` needs a daemon bounce; `shadow → on` does not.
- **`captainChannel`** — `on` makes crew wrapper/receipt text visible in captain panes (noisier, but delivery-verified); `shadow` keeps captain panes clean while still comparing against the old inference path for verification. Design doc: [`docs/specs/2026-08-13-agent-control-channel-design.md`](docs/specs/2026-08-13-agent-control-channel-design.md). Diagram: [`docs/diagrams/2026-08-13-agent-control-channel.html`](docs/diagrams/2026-08-13-agent-control-channel.html).
- Scope is deliberately fixed to `claude` and `opencode` only — both expose a native control API that's been exercised live; `pi`/`gemini`/ACP agents don't fit this model and are out of scope (see the design doc's Appendix A).

## Coding Discipline: Karpathy Principles

Every coding task in this repo follows [`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md):

1. **Think before coding** — surface assumptions and tradeoffs; ask if ambiguous
2. **Simplicity first** — no speculative abstractions, no impossible-case error handling
3. **Surgical changes** — every changed line traces to the request; no drive-by refactors
4. **Goal-driven execution** — define verifiable success criteria before implementing

## Reporting squadrant bugs

**Captain** (interactive — can search, decide, and file): If you or a crew hit an error or behavior that looks like a defect in *squadrant itself* — a `squadrant`/`squadrantd` command throwing a stack trace through `dist/`/`packages/`, a daemon/socket crash (`ECONNREFUSED`/`EADDRINUSE`), an `ENOENT` or wrong path in a path squadrant computed, a state-machine invariant throw, or a lifecycle signal that should have fired and didn't — and it is **not** one of the noise cases below, then search `tu11aa/squadrant`:

```
gh issue search --repo tu11aa/squadrant --state all "<short signature>"
```

- **Already fixed** in a release newer than the running version? → tell the user to update (`npm i -g squadrant@latest`); don't file.
- **Open duplicate?** → don't file; optionally mention "+1, already tracked as #NNN."
- **New?** → offer the user a one-line **y/n** to file (semi-auto — prompt, don't nag). On yes, file with title `[agent-report] <signature>`, label `bug`, and a body containing what happened, best-effort repro, environment (squadrant version + agent + version + OS + node), and a **redacted** error excerpt (banner + top few stack frames only — strip tokens like `ANTHROPIC_API_KEY`/`gh[pousr]_…`/Telegram `\d+:…`, and rewrite `/Users/<name>/…` → `~`).
- If the fix looks small, offer to draft a **PR** instead of / in addition to the issue (see `CONTRIBUTING.md`).

**Never file** (noise — the failures you hit most are not squadrant defects):
- transient model-infra: `API Error: 529`, `Overloaded`, `429`, `retrying 7/10`, `retries exhausted`
- network: DNS/timeout/TLS to the model API
- user/config error: bad project name, a token the user must set, not-a-git-repo
- expected failure: a red TDD test, a lint/type error in the crew's *target* repo
- known flakiness: the relay-proxy tests (baseline = 3 fails)

When any signal is ambiguous, **don't file** — silence beats spam. Cap: at most one new issue per session by judgment; recurring known bugs get a mention, not a re-file.

**Crew** (headless — can't prompt the user, so it routes up): If a task failed because of a defect in *squadrant itself* (not infra/config/an expected failure), say so in your `signal blocked`/`done` message so the captain can check the repo and file it. **Don't file from the crew.**

<!-- squadrant:end -->

