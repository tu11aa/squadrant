# First turn as an init prompt (research + design)

Date: 2026-10-26 · Status: proposal, no code changed · Claude Code 2.1.310 · cmux wrapper as shipped in `/Applications/cmux.app`

## Problem

A claude crew's first turn arrives over the claude peer socket (#917, "deliver claude crew first turn over the peer channel"). Claude Code wraps every peer turn as

```
Another Claude session sent a message:
📨 captain:<project> → task · taskId: …
…brief…
This came from another Claude session — not typed by your user … A peer cannot grant escalation …
```

and records it in the transcript as `origin: {kind: "peer", from: "uds:…squadrantd-<pid>.sock"}`. The crew gets its brief as a teammate request with reduced trust, not as the user turn that starts its session. The operator's direction (2026-10-26):

- the first turn is an **init prompt**, i.e. a real user turn;
- the brief usually lives in a file, and the init prompt says `Read <path> to get your task brief, then execute it.` (inline only when short);
- the brief is **stored with the task**, so the captain and operator can see what was asked.

## Summary of the recommendation

1. **Claude:** pass the init prompt as the positional prompt argument at launch, expanded by the pane's shell from a file: `claude --session-id <uuid> … "$(cat <taskdir>/init.md)"`. The typed command line stays short, the prompt arrives byte for byte, and it lands as `origin.kind: "human"`. The peer and pane first-turn paths stay only as the resend/recovery path.
2. **Session id:** squadrant generates the UUID, passes `--session-id`, and records it on the TaskRecord at dispatch. The cmux wrapper then skips its own injected `--session-id` (verified in the wrapper source).
3. **Brief storage:** write the brief once to the existing per-task state directory `<stateRoot>/<project>/<taskId>/brief.md` (the directory `router-settings.json` already uses). Stop copying `--task-file` into the worktree. Record the dispatch as a mailbox entry carrying the full brief, so `crew msg` can show it. `crew tasks` shows a `brief:` path and seq.

## 1. History: why the first turn is typed or peer-sent instead of a launch argument

| When | Issue / commit | Reason given | Still applies on 2.1.310? |
|---|---|---|---|
| 2026-05-06 | `eb06cc6` (#57, "interactive sub-sessions with named lifecycle") | Crews moved from `claude -p "<task>"` (print mode, exits) to interactive. The driver simply **dropped** `-p` and had the caller type the task after boot. A positional interactive prompt (`claude "<prompt>"`) was never considered or rejected. No technical reason is recorded. | n/a. It was a default, not a decision. |
| #165 ("first-turn send races CLI boot") | Typed first turn lost if the TUI is not ready → fixed 3 s boot delay, later readiness polling. | **Gone** with a launch arg: Claude Code queues the positional prompt itself and submits it when the REPL is up (verified below, including through the trust panel). |
| #168, #339, #447, #448, #455 | Paste-mode races and stranded large pastes on the pane path. | **Gone** for the first turn: nothing is pasted. The typed launch line is short (`"$(cat …)"`). |
| #466 ("spawn never delivers first-turn prompt") / #470 / #472 | Silent drops; fixed by making the `UserPromptSubmit` hook the sole confirmation and adding the daemon self-heal resend. | Confirmation **still needed and still works**: `UserPromptSubmit` fires for the positional prompt with `prompt` = full text (verified). The self-heal stays as a backstop. |
| #730 ("long first-turn task text truncated") / #864 | Multi-KB paste truncated mid-render → `spillOversizedFirstTurn` (1200 B) to `$TMPDIR/squadrant-task-<id>.md` (`packages/core/src/first-turn-spill.ts:20-31`). | **Gone** for the init path: the shell reads the file, so there is no paste or size limit short of `ARG_MAX` (~1 MB on macOS). The spill stays for the pane fallback and side sessions. |
| `sanitizeForCmuxSend` (`packages/workspaces/src/runtimes/cmux.ts:193`) | cmux `send` treats `\n` as Enter, so multi-line text is flattened to one line. | **Gone** for the init path: a newline inside `$(cat …)` output is not a keystroke. Structure is kept (verified, 4-line file arrives with 4 lines). |
| #917 ("first turn over the peer channel") | Replaced the ~2 min screen-scrape path with a peer send gated on registry `idle`. It noted the peer framing as a known cost ("check behaviour on a real long brief"). | Its speed goal is met **better** by the launch arg: no idle wait, no send at all. The framing it accepted is exactly what this proposal removes. |
| Folder-trust panel (#917 §2, `packages/core/src/peer-first-turn.ts:47-55`) | While the panel is open there is no registry entry; newer panels default to "No, exit". | **Partly applies.** The positional prompt waits behind the panel and is submitted after "Yes" (verified). A crew worktree under an already-trusted repo inherits trust and shows **no panel** (verified with a subdirectory). A first spawn in an untrusted repo still needs the panel answered, so keep the existing trust-answer loop (screen check, `trustPanelAcceptKeys`) running during boot. |
| #212 (codex `dispatch`↔`say` race) | Codex-only, daemon-hosted thread map. | Not related to claude. Codex has its own path (§4). |
| #745 / #798 | False "not delivered" → duplicate delivery; unbounded spawn wait. | Duplicate risk is **lower**: the init prompt can never be delivered twice by the spawn itself; only the daemon self-heal can resend, and it already re-checks `firstTurnConfirmedAt` (`packages/core/src/daemon/reduce.ts:453-460`). |
| AFK auto-continue (`CLAUDE_AFK_*`, CLAUDE.md "Managed settings") | Prompts can auto-resolve when idle. | Unrelated to how the first turn is delivered. No change. |

Open first-turn issues that this design touches: #385 (terminalize after recovery is exhausted), #816 (opencode readiness poll), #514 / #201 (codex confirmation and ack timeout).

## 2. Mechanism today

### Claude crew spawn (`packages/core/src/crew-spawn.ts`)

1. `--task-file` (non-shared): the file is **copied into the worktree root** and the first turn becomes `Read ./<basename> to get your task brief, then execute it.` (`crew-spawn.ts:480-486`, #458). The copy is an untracked file in the crew's repo, which blocks `crew close`'s clean-tree check and can be committed by mistake.
2. `dispatchCrew` records the TaskRecord with `task: input.task`, the **full brief text** (`crew-spawn.ts:597-605`, `TaskRecord.task` in `packages/shared/src/types/control.ts:52`).
3. `agent.buildCommand({ prompt: input.task, interactive: true, … })`. For interactive claude, the prompt is **ignored**: the driver appends nothing (`packages/agents/src/drivers/claude.ts:78-80`, only `-p` for non-interactive). No `--session-id` is passed by squadrant.
4. The launch line is typed into the new pane: `cd <cwd> && SQUADRANT_CREW_TASK_ID=… claude -n … --messaging-socket-path …` (`crew-spawn.ts:672`, wrapped by `niceCrewCommand`).
5. First turn: `sendFirstTurnPeer` (`packages/cli/src/lib/first-turn-peer.ts` → `deliverFirstTurnViaPeer`, `packages/core/src/peer-first-turn.ts:57`) waits for registry `idle`, answers the trust panel, and sends the framed brief plus the completion protocol over the peer socket. On `fallback` it pastes into the pane with the 1200 B spill (`crew-spawn.ts:676-685`).
6. Confirmation: the `UserPromptSubmit` hook (`packages/cli/src/commands/hooks.ts:52`) emits `task.first-turn.confirmed`; the reducer stamps `firstTurnConfirmedAt` once (`packages/core/src/state-machine.ts:243-250`). Spawn races that against the scrape (`crew-spawn.ts:692-699`). The daemon's self-heal resends `rec.task` after the undelivered budget (`daemon/reduce.ts:452-490`).

### Session id

- **Captain launch does not pass `--session-id`.** It uses `claude` / `claude -c` (`packages/agents/src/drivers/launch-cmd.ts:64`). The only squadrant user of `--session-id` is `thread` (`packages/cli/src/commands/thread.ts:74`, `--resume … --fork-session --session-id`).
- **The cmux wrapper already injects a `--session-id`** into every `claude` launched in a cmux pane (`/Applications/cmux.app/Contents/Resources/bin/cmux-claude-wrapper:5`). It skips its own when the command already has `--session-id`, `--resume`, `-c`, or `-p` (`claude_explicit_session_flag_present`, wrapper lines 743 and 1816). So squadrant crews have a pre-assigned id today, but squadrant does not know it until a hook reports it.

### Other agents

- **opencode:** interactive TUI launched bare (`packages/agents/src/drivers/opencode.ts:31-35`); first turn pasted into the pane with readiness polling (`crew-spawn.ts:779`), no spill.
- **codex:** no pane typing. `sendCodexFirstTurn` → daemon `say()` → app-server `turn/start` (`crew-spawn.ts:382-390`). That is already a real user input in codex's model; only the `📨` header is added by `frameFirstTurn`.
- **gemini:** print mode only (`gemini -p`, `packages/agents/src/drivers/gemini.ts:23`). Generic pane path at `crew-spawn.ts:816`.
- **side sessions** (`packages/core/src/side-session.ts:179`) use the pane path with the same spill.

### Brief storage today

The brief is in four places, none designed for it:

| Where | What |
|---|---|
| `TaskRecord.task` | full text (used for the short title at `daemon/reduce.ts:192,250`, the resend, and the `crew send` dedupe at `crew-spawn.ts:914`) |
| `$TMPDIR/squadrant-task-<id>.md` | spill copy, pane fallback only, never cleaned |
| `<worktree>/<basename>` | `--task-file` copy, untracked, blocks `crew close` |
| peer transcript | the crew's own transcript |

The mailbox (`packages/core/src/mailbox.ts`) only gets entries for captain-facing notifications (`daemon/delivery-loop.ts:336-352`). There is no dispatch entry, so `crew msg` cannot show what a crew was asked.

## 3. Live verification (throwaway scratch dir only)

Run in a scratch directory under the session scratchpad, driven through a PTY, with `--setting-sources local --settings <scratch hooks.json> --strict-mcp-config` so no user hooks, squadrant hooks, or MCP servers fired. No live captain, crew, or squadrant config was touched. One side effect: answering the trust panel recorded the scratch path as trusted in `~/.claude.json`, which Claude Code does for any trust answer.

| Check | Result |
|---|---|
| `claude --session-id <uuid> --model haiku … "Read <scratch>/brief.md to get your task brief, then execute it."` | Session id honored (`SessionStart`, `UserPromptSubmit`, and `Stop` hook payloads carry `<uuid>`; transcript `<uuid>.jsonl`). |
| Untrusted folder | The trust panel appeared with the cursor on **"No, exit"**. After Down+Enter, the queued prompt was submitted without another send. `Stop` came 4.4 s after spawn. |
| Transcript of the init turn | `{"type":"user","origin":{"kind":"human"},"promptId":…}`, plain text, no peer wrapper. For comparison, this crew's own peer-delivered brief: `origin: {kind:"peer", from:"uds:/tmp/cc-socks/squadrantd-<pid>.sock", verifiedPeerPid:…}` with the "Another Claude session sent a message" wrapper. |
| `UserPromptSubmit` | Fired once with `prompt` = full init text. The existing #466 receipt path works unchanged. |
| `"$(cat init.md)"` with `"quotes"`, `'single'`, parens, `===`, `$HOME`, backticks, a literal `\n`, and 4 lines | Arrived byte for byte (`$HOME` and backticks not expanded, since command-substitution output is not re-evaluated); the model answered `OK-4`. |
| Subdirectory of the trusted scratch dir | **No trust panel.** Trust is inherited from the parent, so worktrees under a trusted repo boot straight into the prompt. |

## 4. Recommended design

### 4.1 Claude (first)

**Files** in `<stateRoot>/<project>/<taskId>/`, the directory already used per task by `writeRouterSettings` (`packages/cli/src/lib/per-crew-settings.ts:177-187`), so no new storage root:

- `brief.md`: the brief exactly as given (`--task-file` contents or the positional task). Written once and never edited.
- `init.md`: the init prompt the agent receives:

  ```
  📨 captain:<project> → task · taskId: <short>          ← keep or drop: open question Q1
  Read <stateRoot>/<project>/<taskId>/brief.md to get your task brief, then execute it.

  <completion protocol from buildCompletionProtocol(id, project, "claude")>
  ```

  **Inline rule:** when the brief is at most `INIT_INLINE_MAX_BYTES` (proposal: 1200, the same threshold as today's spill) **and** came as a positional arg, not `--task-file`, put the brief text in place of the `Read …` line. Size no longer matters for correctness, since `$(cat)` has no paste limit. The rule only keeps short briefs readable in the transcript and long ones out of it, per the operator's direction.

**Launch:**

```
cd <cwd> && SQUADRANT_CREW_TASK_ID=… claude -n … --session-id <uuid> … --messaging-socket-path <sock> "$(cat '<taskdir>/init.md')"
```

- `buildCommand` gets `sessionId` and `initPromptFile` on `SpawnOptions`. Interactive claude appends `--session-id <uuid>` and, **last**, the quoted `"$(cat <shellQuote(path)>)"`. It must come after `--messaging-socket-path` because of the cmux ≤0.64.18 truncation comment at `drivers/claude.ts:66-73`. Verify that the stored `launchCommand.arguments` still classify the role with a trailing positional (test plan T5).
- **Remove** steps 5's `sendFirstTurnPeer` / `sendFirstTurn` from the claude happy path. Keep a **trust watcher** during boot: poll the screen until a registry entry for the crew's pid/socket appears; if `screenShowsTrustPanel`, press `trustPanelAcceptKeys` (reuse from `peer-first-turn.ts`). Bounded by the existing 90 s ready timeout.
- **Confirmation unchanged:** `UserPromptSubmit` → `task.first-turn.confirmed` → `firstTurnConfirmedAt`, with `FIRST_TURN_HOOK_CONFIRM_MAX_MS` as the spawn-side wait.
- **Recovery:** the daemon self-heal and `crew send` resend send the **init text** (`init.md`, small) over the existing peer→pane path. A resend is the one case where peer framing is acceptable: it is a recovery, and it only happens when the launch arg did not land.

### 4.2 Session id

Pre-generate it: `randomUUID()` before `dispatchCrew`, passed as `sessionId` in the dispatch input so the TaskRecord has it from the start (`TaskRecord.sessionId` already exists, `control.ts:53`).

- Transcript path is known at spawn: `~/.claude/projects/<cwd encoded>/<uuid>.jsonl` (same encoding as `hasClaudeSession`, `launch-cmd.ts:18-27`). `crew read`, `crew close` (`sessId`, `crew-spawn.ts:1116`), and resume can use it without waiting for a hook.
- Passing it makes the cmux wrapper skip its own injected id. One id instead of two candidates.
- `--session-id` errors if the id is already in use. A fresh v4 UUID per spawn makes that a non-issue. Never reuse the task id: a respawn of the same task would collide.
- Hooks keep reporting `session_id`. The reducer should warn on a mismatch (it would mean the wrapper or another layer replaced it).

### 4.3 Brief storage and display

Keep to the repo rule *TaskRecord = state only, mailbox = all message text, no new storage places* (#1030 "crew reply truncated before mailbox write", #1045 "fold _results into the mailbox"):

| Piece | Proposal |
|---|---|
| Mailbox | New entry at dispatch, `kind: "task.dispatched"` (a `ControlEvent` like the rest), `payload: { brief: <full text>, briefPath, initInline: bool, sessionId }`, `message: null` (not pushed to the captain pane; the captain wrote it). The full text lives here, matching `task.done`. The daemon records `briefSeq` on the TaskRecord as a pointer, like `lastReplySeq`. |
| `<stateRoot>/<project>/<taskId>/brief.md` | What the crew reads. It exists because the crew needs a path to `Read`, and the mailbox **rotates** (5 MB / 7 days, keep 3: `daemon/start.ts:426-430`, `mailbox.ts:403-409`), so a long-running crew could lose its only copy. Deleted with the task directory on `crew tasks --purge`. |
| `TaskRecord.task` | Today the full text. Proposal: keep it but **bound it** to the first line (≤120 chars, what `reduce.ts:192,250` already derive) once `briefSeq` exists. That needs the `crew send` dedupe (`crew-spawn.ts:914`) and the self-heal resend to read the brief from the file or mailbox instead. Open question Q3: this can be a separate step. |
| Worktree copy (#458) | **Removed.** `--task-file` is read once into `brief.md`; the worktree stays clean, so `crew close` is no longer blocked. |
| `$TMPDIR` spill | Kept only for pane fallback and side sessions. Point it at the task directory instead of `$TMPDIR` in a follow-up. |

Display:

- `squadrant crew tasks <project>`: add a `brief` column with `seq <n>` (or the path in `--json`).
- `squadrant crew msg <project> <seq>`: already prints an entry in full, so the dispatch entry works with no change beyond rendering `payload.brief`.
- Optional sugar: `squadrant crew brief <project> <name|id>` resolves `briefSeq` (falling back to `brief.md` after rotation) and prints it.

### 4.4 opencode / codex / gemini

| Agent | Today | Proposal | Confidence |
|---|---|---|---|
| **opencode** | Bare TUI, first turn pasted after a readiness poll. | opencode's TUI accepts `--prompt <text>` to start with a prompt. Use `opencode --port … --prompt "$(cat init.md)"`. Confirmation: the SSE bridge's first user message for the session (#816 "opencode crew channel has no readiness poll" gets simpler, since no send is needed). | **Unverified here** (opencode is not installed on this machine). Check `opencode --help` and whether the TUI submits `--prompt` or only pre-fills the box. If it only pre-fills, keep the pane path. |
| **codex** | Daemon `say()` → `turn/start`, already a real user input. | No launch change. Send `init.md` contents as the first turn (so the brief is read from the same `brief.md`), and write the same `task.dispatched` mailbox entry. Drop or keep the `📨` header per Q1. | High: no peer framing exists on this path. |
| **gemini** | Print mode (`-p`). | Interactive crews would use `gemini -i/--prompt-interactive "$(cat init.md)"`, which runs the prompt and stays interactive. Out of scope until gemini crews are interactive. | **Unverified** (gemini not installed). |
| **side sessions** | Pane path + spill, `side-session.ts:179`. | Same claude launch-arg change applies (they launch claude too). Separate PR. | Medium. |

Portability note (multi-agent direction): the brief file + init prompt is agent-neutral. Every agent gets `Read <path> …` plus its own completion protocol. Only the launch flag differs per driver, which fits behind `SpawnOptions.initPromptFile` handled in each driver's `buildCommand`.

## 5. Risks

| Risk | Mitigation |
|---|---|
| **Trust level changes.** The brief now runs with **user** authority instead of peer authority. That is the goal, but it also means anything the captain relays into a brief (Telegram text, a crew's output, a web page) gets user authority in the crew. | Captains already treat inbound text as data (CLAUDE.md Telegram section). Keep the `📨 captain:<project>` header in `init.md` so the crew still sees who wrote it (Q1). Crew-template rules (rule 9) about peer input still apply to later turns. |
| Pane shell is not POSIX-like (fish < 3.4, nushell). | `$(…)` works in bash, zsh, and fish ≥ 3.4. The cmux pane runs the user's login shell. Fallback: if `$SHELL` is not bash/zsh/fish, launch through `bash -c '…'` or skip to the existing peer path. |
| Init text starting with `-` would be parsed as a flag. | `init.md` always starts with the header or `Read`. Add an assertion in the writer. |
| cmux ≤0.64.18 truncated stored `launchCommand.arguments` at `--messaging-socket-path`. A trailing positional is lost from the *stored* command, though not from the real exec. | Role classification uses earlier flags, so it is unaffected. Covered by T5. If the stored command is used for cmux session restore, a restored crew would boot without the init prompt, which is correct for a restore. |
| Brief contains secrets and now persists in the state dir. | Same exposure as today (`TaskRecord.task` is already in the state dir). Write `brief.md` with mode 0600. |
| `--session-id` collision. | Fresh UUID per spawn; never derived from the task id. |
| Trust panel in an untrusted repo with no watcher. | Keep the trust watcher (§4.1). Without it the prompt waits forever behind the panel, same failure as #917's 29 s stall. |
| The 90 s first-turn hook-confirm window may now trigger on slow boots. | Boot plus first prompt submit measured at ~1-4 s here; keep `FIRST_TURN_HOOK_CONFIRM_MAX_MS`. |
| Mailbox rotation drops the dispatch entry for long-lived crews. | `brief.md` is the durable copy; `crew brief` falls back to it. |

## 6. Test plan (throwaway project only)

Unit:

- **T1** `drivers/claude.ts`: with `sessionId` + `initPromptFile`, the command has `--session-id <uuid>` and ends with `"$(cat '<path>')"` after `--messaging-socket-path`; paths with spaces and quotes are shell-quoted. Without them, the output is byte for byte the same as today.
- **T2** `crew-spawn.ts`: claude spawn writes `brief.md` + `init.md` under `<stateRoot>/<project>/<taskId>/`, does **not** copy into the worktree, does **not** call `sendFirstTurnPeer`/`sendFirstTurn` on the happy path, and passes the same UUID to `dispatchCrew` and `buildCommand`.
- **T3** Inline rule: short positional → inline; long or `--task-file` → `Read <path>`.
- **T4** Mailbox: `task.dispatched` entry with full `payload.brief`, `message: null`; `briefSeq` stamped; `crew msg <seq>` prints it; `crew tasks` shows it.
- **T5** Role classification from a stored launch command that ends in the positional (and one truncated at `--messaging-socket-path`).
- **T6** Self-heal resend sends `init.md` text, not `rec.task`, and still no-ops once `firstTurnConfirmedAt` is set.

Live, in a throwaway project registered only for the test (e.g. `squadrant init` on a scratch repo, `isolatedConfigDir` / `SQUADRANT_STATE_DIR` pointing at a scratch state dir), unregistered afterwards:

- **L1** Spawn a claude crew with a 3 KB multi-line `--task-file` containing `(`, `===`, `:`, `$`, and backticks (the #730 repro). Check: the transcript's first user entry has `origin.kind: "human"`; the crew reads `brief.md` and reports the correct line count; `firstTurnConfirmedAt` is set; spawn→confirm time is a few seconds.
- **L2** Same in a never-trusted repo: the trust watcher answers the panel and the prompt submits afterwards.
- **L3** `crew close` succeeds without `--force` (no untracked brief in the worktree).
- **L4** `crew tasks` / `crew msg` show the brief; after `--purge` the task directory is gone.
- **L5** `crew send` follow-up still works (peer path), and kill-before-submit triggers the self-heal resend once.
- **L6** Codex crew: first turn is the init text, and a `task.dispatched` entry exists.

## 7. Open questions for the operator

- **Q1** Keep the `📨 captain:<project> → task · taskId` header line at the top of `init.md`? It keeps the sender visible and the taskId handy. Without it the turn looks exactly like an operator turn. Recommendation: **keep it.**
- **Q2** Inline threshold: 1200 B for positional briefs, and always a file for `--task-file`? Or always a file? Recommendation: **1200 B inline, file otherwise.**
- **Q3** Shrink `TaskRecord.task` to a one-line title in the same change, or as a follow-up? Recommendation: **follow-up.** The first PR adds `briefSeq` and the files; the second moves the dedupe and resend readers.
- **Q4** Apply the same launch-arg change to side sessions (`side-session.ts`) in the same PR or a separate one? Recommendation: **separate.**
- **Q5** opencode: worth installing it to verify `--prompt` submit behaviour before the PR, or ship claude + codex first? Recommendation: **claude + codex first.**
