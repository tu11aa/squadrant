# Event architecture consolidation — design

**Date:** 2026-08-29
**Status:** design approved, not yet planned or implemented
**Supersedes nothing.** Extends the `LifecycleSource` port (#333) and the control-channel work (#667).
**Companion:** [`docs/diagrams/2026-08-28-event-architecture-current-state-vi.html`](../diagrams/2026-08-28-event-architecture-current-state-vi.html) — current-state inventory
**Background:** [`docs/specs/2026-08-27-harness-plugin-architecture-study.md`](2026-08-27-harness-plugin-architecture-study.md) — DeepSeek Harness / Pi study

---

## 1. Problem

Squadrant infers what a crew is doing from signals it observes from outside. Today those signals
enter through **two parallel mechanisms with two different state models**, and nothing forces the
two to agree.

| | Mechanism B — direct `ControlEvent` | Mechanism A — `LifecycleSource.report()` |
|---|---|---|
| Producers | 16 files across 5 packages | 5 registered sources |
| Entry point | `applyEvent()` | `reduceLifecycle()` |
| State model | `TaskRecord` (26 event variants) | 4 states + `origin` reconciliation |

Verified problems, in the order they matter:

1. **Semantics live in a bare string.** `task.progress.note` carries the real meaning. Tool-window
   pairing is keyed on string equality across feeds that spell the same fact differently. This
   produced #542 (false `CREW STALLED` for months). The fix (`15ea2fe`, merged) added one more
   spelling to an OR-chain; the design that made it possible is unchanged. The opener still matches
   exactly one spelling (`"agent.hook.PreToolUse"`) while the closer matches three, so
   `NativeHookSource`'s `"pre-tool-use"` still opens no window.

2. **A reverse loop, agent-scoped.** `CodexAppServerSource` and `OpencodeControlSource` do not read
   raw signals. The daemon wires `emit = (ev) => { source.observe(ev); handle(ev); }` inside each
   driver's emit closure, so they consume already-translated `ControlEvent`s and translate them
   *back* into `LifecycleSnapshot`s. The same real-world occurrence runs through two reducers in two
   directions. Confined to codex and opencode crews — the claude path (`CmuxEventsBridge`) has no
   `observe()` call.

3. **A dead lifecycle feed.** `NativeHookSource.handleHook()` — the only method that populates its
   cache and calls `deps.report()` — has **no caller in shipped code** (30 call sites, all in
   `native-hook-source.test.ts`). The source contributes zero snapshots and its `snapshot()` liveness
   floor always returns `undefined`. Its `install()` half is real and load-bearing (#615). The live
   hook path is `squadrant hooks claude <sub>` → `mapHookSub()` → socket → `applyEvent`.

4. **Nothing is replayable.** `TaskRecord` is a fold; the `ControlEvent` that produced it is
   discarded. After a bad day there is nothing to read back.

5. **Nothing notices an event with no producer or no consumer.** Three variants — `heartbeat`,
   `task.idle`, `task.reconcile-failed` — have `state-machine` cases, sit in the socket-boundary
   allowlist (`reduce.ts:292-297`), and `task.idle` even has a Telegram formatter — but no shipped
   code emits them. Only tests do.

**Suspected, not reproduced:** `pendingTool` is a single optional slot. Claude commonly runs tools in
parallel. Reading the code, three `PreToolUse` in a row leave the slot holding the third (resetting
`since`), and the first `PostToolUse` clears it while two tools are still running. This would close
the window too early *and* prevent `since` from ageing while new tools keep starting. Not verified by
execution — treat as a hypothesis to test with a captured fixture, not as a known defect.

### What is already right and must not change

- `ControlEvent` is a typed discriminated union.
- `applyEvent()` is a single ingress with an exhaustive type guard at the socket boundary.
- `reduceLifecycle()`'s four reconciliation rules (agent-authoritative, scans cannot assert
  `needsInput`, agent-set `needsInput` is sticky, a stale scan cannot regress) are correct.

**Consolidating is not rewriting.** The work is to make ingestion one-way and to name what is
currently a bare string.

---

## 2. Goal and success criterion

The chosen primary goal is **onboarding a new agent must be cheap**.

> **Success criterion.** After Phase 0, adding a new agent is **one adapter file plus one fixture
> registration**, and that PR changes **zero files under `core/src/`**.

Measurable, and it fails loudly: if an agent PR has to touch `core/`, the seam is wrong.

Secondary goals, expected to follow but not the acceptance bar: fewer false lifecycle signals, and a
readable one-way flow.

### Non-goals

- Not a plugin framework. No DI container, no service registry.
- Not a replacement for `ControlEvent`, `state-machine`, or `watchdog`.
- Not a new transport. It consumes the sources that already exist.
- **Does not make opencode reliable.** It makes opencode's failures *visible* (`unknown` facts, I5,
  the flight recorder). Fixing opencode is separate, later work.

---

## 3. Scope

**In scope — the "observed" event family only** (~13 variants): facts derived from hooks, streams,
scans, and pane text.

**Out of scope:**

- **"Asserted" events** (`task.done`, `task.review`, `task.cancelled`, `crew.takeover.*`) — a human
  or a crew declared these. They are already trustworthy and need no reconciliation. They continue
  to reach `applyEvent` directly.
- **"Derived" events** (`task.stalled`, `task.quiet`, `task.timeout`, `task.warn`) — the watchdog
  synthesises these. They are *decisions*, not observations, and belong after the reducer.
- **`task.blocked`** — behaviour unchanged, permanently. It straddles both families (crew
  `signal blocked`, plus `interactive-probe` and `claude.ts` trailing-question detection) and it is
  the highest-traffic path.

  Precisely: the observed blocked-family signals are **recorded** as `input.requested` /
  `permission.requested` facts so replay has no hole at the most frequently exercised point, but the
  pipeline **never emits** a `task.blocked` `ControlEvent` — not in shadow, and not after cutover.
  Its existing producers keep that job. Without this rule, cutover would double-emit against
  `interactive-probe`.
- **codex.** `CodexAppServerSource` and its reverse loop stay exactly as they are.
- **`NativeHookSource`.** Kept as-is and **deferred**. Not deleted, not wired up. Add a comment at
  the class marking the `LifecycleSource` half inert (`handleHook` has no caller) so the next reader
  does not rediscover it.

After Phase 4, `ctx.lifecycleSources` holds **3** entries: the new facade, the inert
`NativeHookSource`, and `CodexAppServerSource` (out of scope). `CmuxStoreSource` and
`ClaudePeerRegistrySource` are absorbed into the facade as adapters and no longer register
themselves.

**Agents in scope: claude and opencode.** Both mandatory. `crewRouting` sends the `hard` and
`extreme` tiers to opencode, so it is not a side branch — it carries the heavy work.

---

## 4. Architecture

Approach **A1**: the vocabulary, log, invariants, and facade live in `@squadrant/core`. Adapters stay
in their current homes and only change what they emit. No new workspace package — `agents` and
`workspaces` already import `LifecycleSource` from `@squadrant/core`, so the dependency edge exists,
and `reduceLifecycle` already lives in `core/src/lifecycle-source.ts`.

```
core/src/events/
  fact.ts          AgentFact union + FactAdapter seam
  log.ts           flight recorder: ring buffer + dump + full-log flag
  invariant.ts     PURE — rules and violation detection
  source.ts        the single LifecycleSource facade
  conformance.ts   exported test suite every adapter runs against itself
```

Adapters, in place:

| Adapter | File | `origin` |
|---|---|---|
| `cmux-events` | `workspaces/src/cmux-daemon/events-bridge.ts` | `agent` |
| `claude-hook` | `cli/src/commands/hooks.ts` | `agent` |
| `claude-peer` | `agents/src/claude/peer-registry-source.ts` | `agent` |
| `cmux-scan` | `workspaces/src/cmux-daemon/cmux-store-source.ts` | `scan` |
| `pane` | `core/src/crew-pane-reader.ts` | `inferred` |
| `opencode-sse` | `agents/src/opencode/sse-bridge.ts` | `agent` |

### One-way flow

```
raw signal → FactAdapter.translate() → AgentFact → log.push() → invariant.check()
                                                        ↓
                                          reduceLifecycle()   (unchanged)
                                                        ↓
                                     toControlEvent(fact, state) → 0..n events
                                                        ↓
                                          applyEvent → state-machine → TaskRecord   (unchanged)
                                                        ↑
                            user commands ──────────────┤   (bypass the pipeline)
                            watchdog ───────────────────┘
```

No component reads a `ControlEvent` in order to produce a fact. That edge is what creates problem #2,
and it is removed for opencode; for codex it remains, out of scope.

`toControlEvent` runs **per fact** and may return zero, one, or several `ControlEvent`s. Most facts
produce none (they only move liveness state); a `turn.ended` typically produces one.

### Removed as registered `LifecycleSource`s

- `OpencodeControlSource` — deleted. The SSE bridge becomes a `FactAdapter` reading its own raw
  stream, which is what removes the reverse loop for opencode.
- `CmuxStoreSource` and `ClaudePeerRegistrySource` — not deleted, but demoted: their translation
  logic becomes adapter code behind the facade, and they stop registering in `ctx.lifecycleSources`.

---

## 5. Vocabulary

```ts
type FactSource = "cmux-events" | "claude-hook" | "claude-peer"
                | "cmux-scan"   | "pane"        | "opencode-sse";

/** Trust rank. Declared once per adapter, never per fact — an adapter cannot lie about its rank. */
type FactOrigin =
  | "agent"      // hook / stream stated it — authoritative
  | "scan"       // inferred from a pid or file sweep — liveness only
  | "inferred";  // read off pane text — weakest; never terminal on its own

type AgentFact = { seq: number; taskId: string; at: number; source: FactSource; origin: FactOrigin } & (
  | { kind: "session.started";      pid?: number; sessionId?: string }
  | { kind: "session.ended" }
  | { kind: "prompt.submitted" }
  | { kind: "turn.ended";           turnId?: string }
  | { kind: "tool.opened";          tool: string }
  | { kind: "tool.closed";          tool?: string }
  | { kind: "input.requested";      question: string; requestId: number }
  | { kind: "permission.requested"; question: string; requestId: number; tool: string }
  | { kind: "activity" }                    // notification, subagentstop — proves liveness only
  | { kind: "process.observed";     alive: boolean; pid?: number }
  | { kind: "unknown";              name: string }
);
```

### The seam

```ts
interface FactAdapter {
  readonly name: FactSource;
  /** Trust rank for every fact this adapter produces. */
  readonly origin: FactOrigin;
  /** Translate one raw frame. MUST NOT throw. MUST NOT return null. */
  translate(raw: unknown): Array<Omit<AgentFact, "seq" | "taskId" | "source" | "origin">>;
}
```

`seq`, `taskId`, `source`, and `origin` are stamped by the facade. An adapter only translates; it
does not need to know which crew it is looking at, and it cannot claim an authority it does not have.

### Three decisions worth recording

**No `callId`.** The original study proposed pairing tool open/close by an explicit call id, copying
`dsh-session/invariant.ts`'s `pendingCalls: Set<CallId>`. **This is not implementable here.** The cmux
event payload carries only `{_source, session_id, cwd, phase, tool_name}`; the Claude hook payload
carries `tool_name` and `tool_input`; `claude.ts:34` explicitly notes the absence of a
`tool_use_id`. No call id exists anywhere in the repo. Synthesising one is false precision — a closer
has no way to know which opener it matches.

**Pair by depth instead.** `tool.opened` increments, `tool.closed` decrements. No id needed, and it
catches drops in *both* directions: `depth > 0` at turn end means a lost close (#542); `depth < 0`
means a lost open. It also fixes the single-slot parallel-tool weakness described in §1.

**`unknown` carries the event name, not the raw frame.** Cheaper in the ring buffer, and it means the
flight recorder never holds `tool_input` — no file paths, file contents, or prompt text ever reach
disk. Nothing to redact later.

**Correlation fields travel on the fact.** `turnId`, `requestId`, and `tool` are carried rather than
regenerated downstream. Discovered while planning against the real opencode bridge: it mints
`requestId` from its own counter (`this.nextRequestId++`) and passes `sessionID` as `turnId`, and
`toControlEvent` must reproduce `task.approval.requested` and `task.turn.completed` byte-for-byte for
shadow comparison to mean anything. A downstream-generated id would differ on every run and make
every shadow comparison a false disagreement.

**What stays in the bridge.** The opencode bridge also holds `pendingPermByTask`, which `answer()`
needs to POST a decision back. That is side-effect bookkeeping, not lifecycle translation, and it
does **not** move into the adapter.

---

## 6. Flight recorder

A ring buffer of **256 facts per crew** in memory. At `maxCrew: 5` that is roughly 150 KB resident.
The size is a config value, not a constant. 256 is a starting point chosen to cover the minutes
before a failure, not a measured optimum — revisit once real dumps exist.

**Dump to disk when:**

- an invariant reports a violation;
- a crew enters `stalled` or `failed`;
- an operator runs `squadrant crew dump <id>`.

Written to `~/.config/squadrant/facts/<project>/<taskId>-<ts>.jsonl`, retained 30 days.

**Fixture-collection flag:** `SQUADRANT_FACT_LOG=1` (or `defaults.factLog`) writes every fact
continuously instead of waiting for trouble.

**Volume note.** Scan-origin adapters poll. They must emit a fact **only on change**, never per tick,
or the buffer fills with noise and the recorder loses its value.

---

## 7. Invariants

Config: `{ enabled: boolean, strict: boolean }`. In tests and shadow mode a violation **throws**; in
production it logs at warn and increments a counter surfaced in the daemon snapshot.

| | Rule | Catches |
|---|---|---|
| **I1** | `tool.closed` while depth is 0 | a lost open, or an adapter mistranslation |
| **I2** | `turn.ended` while depth > 0 | **#542** |
| **I3** | depth > 0 and the oldest open is older than the stall budget | reports *before* the watchdog terminalises |
| **I4** | an `origin:"inferred"` fact never produces a terminal `ControlEvent` alone | **#704** |
| **I5** | any `unknown` fact within a 5-minute window, naming `source` + event name | any future dropped-frame bug, **on first occurrence** |
| **I6** | two sources report conflicting liveness for one crew within 5 s | the 2026-08-13 "three false lifecycle signals" session |

Both windows (5 min, 5 s) are config values with those starting defaults, not tuned constants. I5 is
deliberately a threshold of *one* — a single unrecognised frame is the signal, and rate-limiting the
warning is the log's job, not the invariant's.

**Dropped from the earlier study: "`seq` must strictly increase."** In this design the facade stamps
`seq`, so it always increases by construction. The invariant would be vacuous. The useful checks are
relational, not sequential.

I4 is additionally enforced by the type system: `origin` is declared on the adapter, so a pane
adapter cannot produce an `agent`-ranked fact even by programming error.

---

## 8. Error handling

Containment at the dispatcher, following `dsh`'s `defensive-patterns.md`:

- `adapter.translate()` throws → the facade catches, emits `{kind:"unknown", name:"<adapter> threw"}`
  plus a violation, and continues. A broken adapter never kills the source.
- An adapter returns a value that does not match the schema → treated identically.

**Degraded passthrough.** During shadow the old path is live, so a pipeline failure is harmless.
After cutover there is no cushion — a dead pipeline means a silent crew. If the facade throws at its
outermost boundary it switches to passthrough: translate facts straight to `ControlEvent`s via a
minimal table, skipping invariants and `reduceLifecycle`. Less clever, but a crew never goes silent.

---

## 9. Testing

1. **Adapter unit tests** — real captured frames in, exact facts out.
2. **Conformance suite** (`core/src/events/conformance.ts`, exported). Every adapter runs it. Checks:
   never throws on garbage / `null` / truncated JSON; never returns `null`; an unrecognised input
   yields `{kind:"unknown"}` rather than an empty array or a throw; `origin` is constant.
3. **Reducer and invariant table tests** — pure, no infrastructure.
4. **Replay** — fixture JSONL in, assert the exact `ControlEvent` stream and the exact violation list.
5. **Shadow disagreement log** — production evidence, Phase 3 only.

**The single enforcement rule:** every `FactAdapter` must register a conformance fixture, and
`pnpm test` fails if one does not. That is the entire governance layer. A heavier mechanism would
need a team to police it and would decay.

**Fixture honesty.** Only fixtures captured from a live crew are real bytes. #542 is already fixed and
cannot be re-captured, so its fixture is a **reconstruction** from known frame shapes and must be
labelled as such in the file. The fixtures worth capturing live are `parallel-tools` (to test the §1
hypothesis) and `happy-path-claude`.

Naming: `fixtures/<issue-number>-<slug>.jsonl`.

---

## 10. Phasing

| Phase | Work | Risk |
|---|---|---|
| **0** | Vocabulary, flight recorder, invariants, conformance suite. No wiring. | none |
| **1** | **opencode** adapter, direct swap. Delete `OpencodeControlSource`. | low |
| **2** | **claude** adapters in shadow. Compute and log disagreements; emit nothing. | none |
| **3** | Read the disagreement log. Fix or accept each. Cut claude over when disagreements reach zero or are explained. | medium |
| **4** | Delete the old direct-emit paths for claude. | low |

**opencode goes first, before claude, deliberately.** It is the lower-stakes proving ground:
`controlChannel.opencode` is `off` and the branch is already known to misfire, so a direct swap risks
little and may improve things immediately. If the first adapter written works there, the seam is
validated before the branch carrying production is touched.

The critical path is not adapter code. It is **`toControlEvent`** — the mapping that must reproduce
exactly what the 16 current producers emit today. If it does not, shadow mode reports disagreements
everywhere and cannot distinguish an improvement from a regression.

**This spec is two implementation plans, not one.** Phases 0–1 are self-contained and shippable: the
module exists, opencode runs on it, nothing else changed. Phases 2–4 depend on evidence that does not
exist yet (the shadow disagreement log) and should be planned only after Phase 1 lands. Planning all
five now would be guessing at Phase 3's content.

---

## 11. Open items

- Ring buffer size (256) is a starting value, not measured.
- The parallel-tool single-slot weakness (§1) is a code-reading hypothesis. Confirm or refute with a
  captured `parallel-tools` fixture before claiming it as a fix.
- The three zombie variants (`heartbeat`, `task.idle`, `task.reconcile-failed`) are out of scope here.
  Removing them, or giving them producers, is separate cleanup.
- `CLAUDE.md:51` states 3 `LifecycleSource` implementations; 5 are registered
  (`squadrantd.ts:222-225`). Documentation fix, unrelated to this design but worth doing while nearby.
- A generated `ControlEvent` producer/consumer table (~150 lines, walking `packages/*/src` for
  `type: "task.…"` literals) would make a variant with no producer or no consumer visible at every
  build. Independent of this design and cheaper than it; worth filing separately.

---

## Appendix — evidence

| Claim | Source |
|---|---|
| `deriveRunState` default returns `null` (silent drop) | `workspaces/src/cmux-daemon/events-bridge.ts:58-68,229` |
| #542 fixed and merged | commit `15ea2fe`, PR #736, ancestor of `develop` |
| Opener matches 1 spelling, closer matches 3 | `core/src/state-machine.ts` `nextPendingTool` |
| Reverse loop is per-driver, not global | `cli/src/squadrantd.ts:168,185` (inside each driver's emit closure) |
| `handleHook()` has no shipped caller | `grep -rn handleHook packages --include='*.ts'` — 30 hits, all in `native-hook-source.test.ts` |
| Live hook path is the socket | `cli/src/commands/hooks.ts:173` `sendToSock({kind:"event", …})` |
| No tool call id in any payload | `events-bridge.ts:199`; `agents/src/interactive/claude.ts:34` |
| 5 sources registered | `cli/src/squadrantd.ts:222-225` |
| Zombie variants | `state-machine.ts:147,237,241`; `reduce.ts:292-297`; `telegram/format.ts:18` |
| Agent config | `~/.config/squadrant/config.json` — `controlChannel: {claude:"on", opencode:"off"}`; `agents: {claude}`; `crewRouting` hard/extreme → opencode |
