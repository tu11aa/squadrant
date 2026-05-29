# Orca — How It Wraps/Drives Codex (Study vs. Cockpit's app-server Design)

**Date:** 2026-05-19
**Subject repo:** https://github.com/stablyai/orca @ `03b88951` (HEAD, 2026-05-19, commit "feat: expand ai commit agent support (#1928)")
**Studied at:** `/tmp/orca-study` (shallow clone)
**Why:** We are about to finalize "interactive codex" for cockpit using Approach 3 (typed JSON-RPC client for `codex app-server` + launchd daemon owning one long-lived child). Question: does orca validate, improve, or warn against the app-server path?

---

## 1. What Orca Is

Orca ("The AI Orchestrator for 100x builders", onOrca.dev, by stablyai) is an **Electron desktop IDE** (TypeScript; `electron.vite.config.ts`, `node-pty`, `@xterm/xterm`) that runs *any* CLI coding agent — Claude Code, Codex, Grok, Gemini, OpenCode, ~30 listed — **side-by-side in terminal tabs/panes across git worktrees**. It adds worktree management, source-control review, GitHub/Linear integration, SSH remotes, a mobile companion app, and an autonomous multi-agent **orchestration coordinator**. It is closed-architecture-wise a *terminal multiplexer for agents*, not a protocol client. The README's framing — "Multi-agent terminals — Run multiple AI agents side-by-side in tabs and panes" — is literally the architecture.

Codex is one of ~30 agents and is **not special-cased** in the launch path. It flows through the same generic TUI-in-PTY machinery as every other agent.

---

## 2. EXACTLY How Orca Drives Codex (the mechanism, with evidence)

**Headline: Orca runs codex as its plain interactive TUI inside a `node-pty` pseudo-terminal, rendered with xterm.js. It does NOT use `codex app-server`, `codex exec`, `codex mcp-server`, or `codex remote-control` to drive the agent.** Turn/done state comes from **codex's own native hooks system**, not from the protocol and not from scraping the TUI for status.

### 2.1 Agent launch = bare interactive `codex` in a PTY

`src/shared/tui-agent-config.ts:70-82` — the canonical per-agent launch table:

```ts
codex: {
  detectCmd: 'codex',
  launchCmd: 'codex',          // <-- bare TUI, no subcommand
  expectedProcess: 'codex',
  promptInjectionMode: 'argv',
  preflightTrust: 'codex',
  draftPasteReadySignal: 'codex-composer-prompt'
}
```

`launchCmd: 'codex'` — no `exec`, no `app-server`. The header comment (lines 52-57) states this table is "which binary it actually launches, and whether the initial prompt should be passed as an argv flag/argument or typed into the interactive session after startup." The process is spawned via `node-pty` (`src/main/providers/local-pty-provider.ts:11` `import * as pty from 'node-pty'`; `:317` `ptySpawn: pty.spawn`; SSH variant in `ssh-pty-provider.ts`). Binary resolution: `src/main/codex-cli/command.ts:147` `resolveCodexCommand()` — pure PATH/version-manager probe, returns a path; no invocation logic.

### 2.2 Turn / "done" detection = codex's native hooks → loopback HTTP

This is the important part. Orca does not infer turn state from PTY output. It **installs managed entries into codex's own hooks system** and listens for the events.

`src/main/codex/hook-service.ts:42-49`:

```ts
const CODEX_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'Stop'
] as const
```

`install()` (`hook-service.ts:250-340`) writes a managed shell script and registers it in `~/.codex/hooks.json` for each event, plus writes per-hook **trust entries** into `~/.codex/config.toml`. The managed script (`hook-service.ts:103-133`) is a `/bin/sh` (or `.cmd`) wrapper that reads the hook JSON on stdin and `curl`s it to a **loopback HTTP server** with a bearer token:

```sh
curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/codex" \
  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \
  --data-urlencode "paneKey=${ORCA_PANE_KEY}" ... --data-urlencode "payload=${payload}"
```

The receiver is `src/main/agent-hooks/server.ts` (a loopback `http.createServer` with bearer auth, IPC fanout, and an on-disk `last-status.json` cache that survives restart — see its header comment, `server.ts:1-12`). So:

- **`Stop`** = turn done (real signal from codex itself, not a heuristic).
- **`UserPromptSubmit` / `PreToolUse` / `PostToolUse`** = live in-flight readout (tool name + input preview between prompt and Stop) — `hook-service.ts:37-41`.
- **`PermissionRequest`** = the human-in-the-loop boundary. Per the comment at `hook-service.ts:39-41`: "the managed script exits without a decision so Codex still shows its normal approval UI, while Orca can flip the pane to the red waiting state." Orca does **not** intercept/answer approvals over a protocol — the approval is answered by the human *in the codex TUI*; the hook is a passive observer that just repaints the pane.

This means **codex's interactive approval/question UI is left fully intact and the human interacts with it directly in the rendered terminal.** Orca only observes state transitions out-of-band.

### 2.3 The two narrow places codex's non-TUI surfaces ARE used

**(a) `codex app-server` — telemetry side-probe only.** `src/main/rate-limits/codex-fetcher.ts:84-261`. To populate the rate-limit status bar, orca spawns a *separate, short-lived* `codex -s read-only -a untrusted app-server` child (`:99-106`), speaks JSON-RPC over stdin/stdout, and asks exactly one question. This is a fully working, production app-server client and is **gold for our design** (see §5). It does the LSP-style handshake (`:142-181`): `initialize` request → wait for response → `initialized` *notification* → then `account/rateLimits/read`. Newline-delimited JSON-RPC framing (`:160-164`). It then **kills the child** (`:191`) — single-shot, not long-lived. On any RPC failure it falls back to a PTY that spawns `codex`, waits for the `>` prompt, types `/status\r`, strips ANSI, and regex-scrapes the output (`:264-425`, `fetchCodexRateLimits` Path A→B at `:431-461`). The comment at `:440-441` is telling: "app-server can fail independently of the interactive CLI."

**(b) `codex exec` — non-agent commit messages only.** `src/shared/commit-message-agent-spec.ts:248-269`: `codex exec --ephemeral --skip-git-repo-check -s read-only --model <m>` with the diff on **stdin** (comment `:251-253`: argv would exceed Windows/SSH command-line limits). This is one-shot text generation, not agent orchestration.

**(c) Input-timing screen-scrape (minor).** `draftPasteReadySignal: 'codex-composer-prompt'` (`tui-agent-config.ts:81`, consumed in `src/renderer/src/lib/agent-paste-draft.ts`). To time a bracketed-paste of a draft prompt, orca watches the rendered PTY stream for codex's `›` composer prompt (comment `:44-49` even cites codex's internal `chat_composer.rs`). This is the *only* place orca reads codex's rendered TUI to make a decision, and it's purely for paste timing, not state.

### 2.4 Autonomous multi-agent orchestration model

`src/main/runtime/orchestration/coordinator.ts` + `preamble.ts`. When orca runs agents autonomously, the coordinator `createTerminal()`s a worktree PTY, launches the agent's TUI, and **injects a prompt preamble that teaches the agent Orca's own CLI** (`preamble.ts:buildDispatchPreamble`): the agent is instructed to call `orca task complete --body <3-sentence summary>` when done and to emit heartbeats every 5 min. Completion is therefore detected by **the agent voluntarily calling back via the orca CLI**, backed by stale-heartbeat thresholds (10 min) and an auto-fail policy (`coordinator.ts:172,230,332-335`). Not protocol-driven; cooperative + watchdog.

### 2.5 Session / resume model

**There is none for codex.** Grep for `codex.*resume`, `experimental_resume`, `rollout`, `--continue`, `conversationId` in non-test source returns nothing. A "session" in orca = a PTY + an xterm.js buffer + a stable `paneKey`. Resilience across **orca** restart is handled by: (a) the `last-status.json` disk cache so dashboard rows reappear (`server.ts:1-12`), and (b) the managed hook script re-sourcing `$ORCA_AGENT_HOOK_ENDPOINT` on each fire so a *surviving* PTY keeps reporting to the *new* orca instance's port/token (`hook-service.ts:104-112`). But the **codex conversation itself is not resumable** — if the PTY dies, the conversation is gone; there is no `thread/resume`-equivalent. Orca's whole resilience story is "keep the PTY alive and re-attach the observer," not "reconstruct the conversation."

---

## 3. Codex Version Assumptions

Orca tracks codex closely and encodes version-specific gotchas:

- `src/main/codex/config-toml-trust.ts:14,20` and `hook-service.ts:151,297`: **"Codex 0.129+ requires a per-hook trust entry in config.toml or the hook sits in the 'review required' pile"** / "Codex 0.129+ silently drops untrusted hooks." Orca computes and writes `trusted_hash` entries (mirroring codex's `codex-rs/config/src/fingerprint.rs::version_for_toml` and `codex-rs/hooks/src/lib.rs::hook_event_key_label`) so the user doesn't have to `/hooks-approve`.
- `src/cli/codex-command-classification.ts:1-37` enumerates the codex subcommand surface orca knows: includes `exec`, `app-server`, `mcp-server`, `remote-control`, `exec-server`, `stdio-to-uds`, `cloud`, `cloud-tasks`, `responses-api-proxy` — i.e. orca is aware of the full modern (≥0.13x-era) codex CLI but uses it only to classify "is this command safe to run in a background PTY vs. does it need a visible terminal."
- Model price table (`codex-usage/store.ts:47-55`) lists `gpt-5.1`/`5.2`/`5.3`-codex variants; commit-spec lists `gpt-5.5`/`gpt-5.4` — consistent with a **late codex-cli ~0.13x** assumption, the same neighborhood as our target `codex-cli 0.130.0`. **The 0.129+ hook-trust requirement is directly relevant to us and is the single most reusable production lesson in the repo (even though it's for the hook path, not app-server).**

---

## 4. Other Codex-Wrapping Tools Referenced

The user's belief that "tons of others wrap codex" is **not corroborated by orca's code or deps**. Orca depends on none of them. The only adjacent things present:
- It *competes with* the same category (it's itself a wrapper). README lists ~30 *agents* it hosts, not wrappers it uses.
- It hosts codex's own subcommands as pass-through (`mcp-server`, `app-server`, `remote-control` appear only in the command-classifier, never invoked for orchestration).

No `node-pty`-of-codex library, no third-party codex SDK, no `@openai/codex` programmatic dependency. Orca's approach is bespoke and TUI-centric. If "tons of others wrap codex," orca is not evidence of *how* — it's evidence that at least one serious, well-engineered multi-agent product chose **TUI-in-PTY + native hooks** over the app-server protocol for the agent loop.

---

## 5. What This Means for Our app-server Design (Approach 3)

### Net verdict: **Our design holds. Orca does not invalidate the app-server path — it makes the case for it from the opposite direction, and hands us a working reference client and a concrete version gotcha.**

**Where orca validates us:**

1. **It confirms TUI-scraping is the wrong way to drive a turn.** Orca — a mature, ~2000-PR product — explicitly does *not* parse codex's full-screen TUI for turn/done state. It went out of its way to install codex's *native hooks* instead, and only screen-scrapes for trivial paste-timing and a fallback `/status` read it openly distrusts ("app-server can fail independently of the interactive CLI", `codex-fetcher.ts:440`). Our explicit rejection of TUI-scraping is the same conclusion reached independently.

2. **`codex app-server` works in production today and we have a reference implementation.** `src/main/rate-limits/codex-fetcher.ts:88-261` is a complete, correct JSON-RPC-over-stdio app-server client. Concretely reusable for Phase 1:
   - **Handshake is mandatory and ordered**: `initialize` (request, with `clientInfo`) → await response → `initialized` (**notification**, no id) → only then other methods. Comment `:142-146`: "Skipping the notification causes 'Not initialized' errors." Bake this into our client's connect sequence and smoke test.
   - **Framing**: newline-delimited JSON objects, one per line; ignore non-JSON lines defensively (`:160-164,219-221`).
   - **Notifications have no `id`** — filter them by `msg.id == null` and route by method (`:172-175`). Our `AgentMessageDelta`/`TurnStarted` handling must not assume an id.
   - **Spawn flags**: orca uses `codex -s read-only -a untrusted app-server`. We will need writable sandbox + approval policy, but note the *global flags precede the `app-server` subcommand* — match that arg order.
   - **Response nesting is real**: rate limits came back wrapped as `{ rateLimits: {...} }` (`:37-41,205-206`). Expect our `turn`/`thread` results to be similarly envelope-wrapped; don't hardcode flat shapes — vendor types from `codex app-server generate-ts` exactly as planned.

3. **Our daemon-owns-one-long-lived-child model is the correct *delta* from orca, not a copy.** Orca's app-server usage is *single-shot and disposable* (`child.kill()` after one request, `:191`). It never holds a long-lived app-server. That's fine for telemetry but is exactly the gap our Phase 2 daemon fills. Nothing in orca contradicts a long-lived app-server; orca simply never needed one because its agent loop is the PTY.

**Pitfalls orca exposes that we should design around:**

4. **Codex 0.129+ hook-trust trap (`config.toml` `trusted_hash`).** This bites the *hook* path, not app-server — but it's a warning that **codex silently degrades when config preconditions aren't met** (hooks "sit in the review-required pile" with no error). Design implication for us: when the daemon spawns `codex app-server`, do not assume silence == success. Add an explicit liveness probe (the `initialize` round-trip) and treat *absence of expected notifications* as a fault, not as "still working." This dovetails with — and strengthens — our **"`TurnCompleted` is liveness NOT completion" anti-false-done invariant**: orca's whole architecture is a cautionary tale that codex can look-alive-but-be-stuck, which is why they leaned on explicit event signals over inference. Keep that invariant; consider also asserting the handshake succeeded before the daemon reports "ready."

5. **app-server can fail independently of the CLI.** Orca keeps a PTY fallback for telemetry precisely because the app-server child can die or error while interactive codex is fine (`codex-fetcher.ts:440-441`). For us this argues for: (a) daemon supervision/restart of the app-server child, and (b) `thread/resume` after a daemon bounce being a *first-class, tested path*, not an afterthought — exactly Phase 2's `thread/resume` for daemon-bounce survival. Orca has *no* conversation-resume at all; that's the dimension where our design is strictly more ambitious, and it's the right ambition because our use case (long-lived orchestrated turns) is the one orca's PTY model can't survive a restart of.

6. **Approvals/human-in-the-loop:** orca punts entirely — it lets the human answer in the TUI and just observes. Our design answers approvals *over the protocol* (`ToolRequestUserInput`, approval requests routed to the cmux-tab client). This is a genuine capability orca lacks; nothing in orca tells us it's wrong, but it does mean **we own a surface orca never had to make robust** — there's no reference code here for the approval round-trip. Treat the approval-request/response path as the highest-novelty, highest-risk part of Phase 1 and smoke-test it explicitly (a `turn/start` that triggers a tool needing approval, answered over RPC, then `TurnCompleted`).

### Recommended adjustments to the Approach-3 plan

- **No structural change. Design holds.**
- **Phase 1 additions (low cost, high confidence):**
  - Lift orca's exact handshake ordering into our client + smoke test: `initialize` → await → `initialized` *notification* → first real method. Assert "Not initialized" cannot happen.
  - Defensive line-framed parser that ignores non-JSON and routes id-less messages as notifications (mirror `codex-fetcher.ts:160-221`).
  - Treat all results as potentially envelope-wrapped; rely on generated TS types, not hand-written flat shapes.
- **Phase 2 additions:**
  - Make the daemon's "ready" signal contingent on a successful app-server handshake probe, not just child-spawned (counter the "silent degradation" pattern orca documents for 0.129+).
  - Elevate the approval round-trip (`ToolRequestUserInput`) to an explicit, independently smoke-tested success criterion — it is the one area with zero prior art in orca and the most likely source of false-done / hang behavior.
  - Keep `thread/resume`-on-bounce as a tested first-class path; orca's total lack of conversation resume confirms this is the differentiating capability, not a nice-to-have.

---

## 6. One-line characterization

> Orca drives codex by **running its interactive TUI in a node-pty and reading codex's own native hook events over loopback HTTP for turn/done state** — it uses `codex app-server` only as a throwaway JSON-RPC telemetry probe and `codex exec` only for commit messages, never to drive the agent, and has no conversation-resume at all. It validates our rejection of TUI-scraping, hands us a correct app-server handshake reference, and — by *lacking* long-lived app-server, protocol approvals, and resume — pinpoints exactly the three areas where Approach 3 is the right bet and must be tested hardest.
