# Message paths audit (#1029, round 2, 2026-10-26)

Every place squadrant puts text in front of an agent or the operator, what it renders as, and where that is tested.
"Header" = the one-line `📨 …` frame ([reference](../reference.md#sender-frame-on-every-delivered-message-1029)).
"Envelope" = the extra `<cross-session-message from-name="…">` wrap that only `ClaudePeerChannel.send` adds, i.e. only for deliveries into a **Claude** session over its peer socket (captain and crew receivers); the pane fallback, opencode and codex get the header alone. The envelope is TUI-only and cosmetic.

Test shorthand: **MP** = `packages/core/src/__tests__/message-paths.test.ts`, **SM** = `squadrant-message.test.ts`, **SF** = `packages/core/src/daemon/__tests__/delivery-loop.sender-frame.test.ts`, **PC** = `packages/agents/src/claude/__tests__/peer-channel.test.ts`.

## A. Into an agent session (framed)

| Path | Code | Sender label | Header rendered | Envelope | Test | Issues |
|---|---|---|---|---|---|---|
| Crew lifecycle: done / blocked / blocked reminder / review / failed / turn failed / idle / stalled / quiet / timeout / held-long / digest / undelivered | `daemon/reduce.ts` `formatMessage` + reminders → `notify` → mailbox → `daemon/delivery-loop.ts` `frameEntry` | `crew:<name>` | `📨 crew:sync-242b → done · taskId: ef2630e1 · seq: 218` (status = verb from the `CREW <VERB> [tag]:` prefix, which is dropped from the body) | yes (claude captain) | MP "crew lifecycle events" (13 rows), SF | `⚠️ CREW UNDELIVERED` and `CREW HELD-LONG … —` did not match the prefix fold → fixed (regex now accepts the `⚠️ ` lead-in, `-` in the verb and ` —` as separator) |
| Crew pane warning (`CREW WARN <name>:`) | `daemon/interactive-probe.ts:180` | `crew:<name>` | `… → warn · taskId · seq` (status from kind `task.warn`; body kept whole, it has no bracket tag) | yes | MP "warn (pane-detected)" | none |
| Stale replay (queued > 1 h) | `daemon/backlog-coalesce.ts` sets `payload.stale`; `down-alert.ts` `staleAge` | unchanged | `… · stale: 3d` appended to the header | yes | `backlog-coalesce.test.ts` (3 cases), `delivery-loop.backlog-coalesce.test.ts`, MP | replaced the `[stale — generated … ago] ` body prefix (it hid the sender); the `[task now <state>] ` annotation stays a body prefix |
| Delegation report-back (`dispatch`) | `daemon/reduce.ts` `formatDelegationReport` → origin mailbox; `mailbox.ts` adds `payload.fromProject` | `crew:<target project>/<name>` | `📨 crew:flooros/sync-242b → done · taskId: ef2630e1 · seq: 218 · reply: squadrant ping flooros "<msg>"`; body now also names `taskId: …` | yes (`crew-flooros-sync-24`) | MP "delegation report-back", `mailbox.test.ts` (fromProject), `daemon.test.ts` (#246 taskId) | before: sender read as the origin project's own crew, no way to tell the project |
| `crew send` (captain → crew, incl. reopen) | `crew-spawn.ts` `runCrewSend` | `captain:<project>` | `📨 captain:app → crew.send · taskId: ef2630e1` | yes (claude crew over peer); header only for pane / opencode HTTP / codex | MP "crew send", `crew-send-control-channel.test.ts` (channel + pane), `crew.test.ts` | agent removed from the header (round 2) |
| `crew answer` | `commands/crew.ts` (structured answer for claude; keystrokes for others) | — | not a message: option keystrokes / text typed into the open prompt | no | `crew.test.ts` | out of scope — it answers a prompt, it does not deliver a message |
| First turn: task brief + completion protocol (claude peer / pane, opencode, codex, generic) | `crew-spawn.ts` (`sendFirstTurnPeer`, `sendFirstTurn`), `first-turn-peer.ts`, codex driver developer instructions | — (captain) | **unframed** by design: the brief is the crew's instruction, not a message to attribute | no (no `📨` header ⇒ `wrapClaudeEnvelope` returns it untouched; PC) | `crew-protocol.test.ts` (snapshot), `driver.test.ts`, PC | follow-up F1 |
| `side send` | `side-session.ts` `runSideSend` | `captain:<project>` | `📨 captain:app → side.send` | yes if the side session is claude over peer; side sessions are pane-fed today ⇒ header only | MP "side send", `side.test.ts` | none |
| Side spawn first turn / thread open first turn | `side-session.ts`, `threads.ts` `openThread` | — | unframed (first-turn briefs, see above) | no | `side.test.ts`, `threads.test.ts` | F1 |
| Thread park request (captain → thread tab) | `threads.ts` `requestPark` | `captain:<project>` | `📨 captain:app → thread.park` | no (pane) | MP "thread park request", `threads.test.ts` | was unframed → fixed |
| Compact resume | `daemon/start.ts` (`deliverToCaptain`) | `daemon` | `📨 daemon → compact.resume` | yes | MP "compact resume" | none |

## B. Into a captain via the mailbox (`captain.message`, framed by `frameEntry`)

| Path | Code | Sender label | Header | Envelope | Test | Issues |
|---|---|---|---|---|---|---|
| Telegram inbound | `telegram/bridge.ts` `handleProjectTopic` (channel path frames directly; mailbox fallback stores `from`) | `telegram:@username` → first name → user id → `telegram` | `📨 telegram:@tu · seq: 9` | yes (`telegram-tu`) | `bridge.test.ts` (frame, `telegramSender`), `__tests__/bridge.test.ts` (append), MP | was a bare `telegram` — now names the user |
| Side handoff | `squadrant runtime send --from side:<name>` | `side:<name>` | `📨 side:research-1 · seq: 9` | yes | MP, `runtime.test.ts` | none |
| Thread park decision | `threads.ts` `parkThread` | `thread:<id>` | `📨 thread:ab12 · seq: 9` | yes | MP, `threads.test.ts` | none |
| `ping` | `commands/ping.ts` | `--from`, else `captain:<current project>` (`resolveCurrentProject`), else `cli` | `📨 captain:projB` (+ `· reply: squadrant ping projB "<msg>"` into another project's captain) | yes | `ping.test.ts` (3 cases), MP | was always `cli` |
| `runtime send` (and `crew takeover` / `handback` notices, which use it) | `commands/runtime.ts` | same rule as `ping` | `📨 captain:projB · seq: 9 …` | yes | `runtime.test.ts` | was always `cli` |
| KB reconcile requests | `commands/knowledge.ts` `enqueue` | `knowledge` | `📨 knowledge · seq: 9` | yes (`knowledge`) | MP | was `cli` — it is neither a terminal nor a person |
| Daemon notices: restart broadcast, down-alert, delivery stuck / not deliverable, context suggestions, knowledge schedule, advisor | `cli/lib/daemon-restart-broadcast.ts`, `daemon/down-alert.ts`, `daemon/delivery-loop.ts`, `context-suggest.ts`, `daemon/start.ts`, `squadrantd.ts` (`source: "daemon"`) | `daemon` | `📨 daemon · seq: 9` | yes (`squadrant`) | MP, SF | none |

## C. Transports

| Transport | Carries | Header | Envelope | Test |
|---|---|---|---|---|
| Claude peer socket (captain + crew) | framed text as `message.content` | yes | **yes** — `from-name` only; no `from=`, never `from-mode` | PC, SM `wrapClaudeEnvelope`, SF |
| opencode control channel (HTTP) | framed text | yes | no | SF (`opencode`) |
| codex app-server | framed text (crew send) | yes | no | `crew-send-control-channel.test.ts` |
| cmux pane fallback | framed text, newlines flattened to spaces by the paste path | yes (one line) | no — pasted text is typed user input, an envelope would show as literal tags | SF (`pane`), `ping.test.ts` |

## D. Out of the agent (operator-facing, never framed)

| Path | Code | Rendering | Notes |
|---|---|---|---|
| Telegram outbound lifecycle | `telegram/format.ts` `formatLifecycle` | `✅ [project] CREW DONE · <full task uuid>\n<message>` | `bridge.test.ts` asserts it is unframed. Follow-up F4: shows the raw task uuid instead of the crew name |
| Telegram receipts / panels | `telegram/bridge.ts` `formatInboundReceipt`, `panels.ts` | plain operator text | unchanged |
| CLI output of `ping`, `crew send`, … | `commands/*` | `✔ / ⏸ / ⚠` lines | operator terminal; unchanged |
| SessionStart / UserPromptSubmit hook injections (rules, profile, unread mailbox) | `commands/hooks.ts` | hook `additionalContext` | not a message delivery — injected context; deliberately outside the frame |

## Follow-ups (not fixed here)

- **F1 — first-turn briefs are unframed.** Claude shows them as an anonymous peer message. Framing them (`📨 captain:<project> → task`) touches the completion-protocol snapshot and four spawn paths (claude peer/pane, opencode, generic, side/thread); worth doing as its own slice.
- **F2 — envelope version gate.** `ClaudeStatusInfo` does not carry the Claude Code version, so the envelope is unconditional. Failure is cosmetic (literal tags), but a `~/.claude/sessions/<pid>.json` `version` check would keep it from showing tags on an older/newer client. Re-verify live on every Claude Code bump (pinned: 2.1.310).
- **F3 — dispatch first turn.** A delegated crew's brief says nothing about its origin project, so the crew cannot address the origin captain. The report-back header now carries the reply hint; the first turn could too.
- **F4 — Telegram outbound shows task uuids, not crew names** (`formatLifecycle`).
- **F5 — Windows peer auth** (spike Q4): unauthenticated daemon posts are dropped there; independent of this work.
- **F6 — redundant body labels.** `📩 [from Telegram]`, `💬 Thread decision`, `🗒 Side handoff` repeat what the header sender now says; kept because they also label the content type.
