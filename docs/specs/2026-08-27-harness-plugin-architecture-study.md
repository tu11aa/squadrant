# Harness plugin architectures — DeepSeek Harness & Pi, and what squadrant should copy

**Date:** 2026-08-27
**Status:** research / thinking material — no code changes, no issues filed
**Author:** side-session `harness-study` (research role)
**Companion:** [`docs/diagrams/2026-08-27-harness-plugin-architectures.html`](../diagrams/2026-08-27-harness-plugin-architectures.html)

---

## 0. Why this exists

The operator's framing, 2026-08-27:

> "At first I was thinking I should rely on cmux events, but now I think we should build the event-tracking module ourselves. I'm inspired by the DeepSeek harness, where everything is a plugin. Or the Pi harness — how they make it a core harness only. I have been building stuff not really efficiently; it's time to build each module more concisely, prove it works reliably, then plug it into squadrant."

The trigger was #542. Earlier today its root cause landed: squadrant's cmux events-bridge opened a tool-in-flight window on `agent.hook.PreToolUse` but **silently dropped** `agent.hook.PostToolUse`, because `deriveRunState()` had no case for it and the classifier's default branch is `return null` (`packages/workspaces/src/cmux-daemon/events-bridge.ts:229`). The window never closed, the #492 veto kept vetoing every real turn-end, and the watchdog fired CREW STALLED at an idle crew — for months.

That is not a typo bug. It is an **architecture** bug: squadrant has no place where "a fact arrived that nothing consumed" is observable.

This document answers: what do these two harnesses actually do, what is worth copying, and what is the smallest self-owned event-tracking module that would have made #542 impossible.

---

## 1. Step 0 — repo identification

### DeepSeek harness

Searched `deepseek-ai`; one candidate, unambiguous:

| Repo | Stars | Pushed | Description |
|---|---:|---|---|
| **`deepseek-ai/deepseek-harness`** | ~199k | 2026-08-21 | *"DeepSeek Harness: Everything is a Plugin."* |
| `deepseek-ai/awesome-deepseek-agent` | 6k | 2026-06-17 | link list |
| `yanhua1010/dsh-harness-tutorial` | 62 | 2026-08-13 | third-party Chinese tutorial for the above |

**Pick: `deepseek-ai/deepseek-harness`** (`dsh`). The README's first architectural sentence is literally *"It uses an architecture where **everything is a plugin**, and is powered by [Cordis]"* — an exact match for the operator's phrasing. Every other hit is downstream of it (the whole `dsh-plugin` GitHub topic exists because of it). No ambiguity to resolve.

### Pi

**`badlogic/pi-mono`** — confirmed. README: *"This is the home of the Pi agent harness project including our self extensible coding agent."* Published as `@earendil-works/pi-*`. Mario Zechner's project; "core harness only" matches: the runtime core is `packages/agent`, and everything user-facing extends it from *outside* via TypeScript extension files. Confirmed the right one.

Both cloned read-only to `/tmp/deepseek-harness` and `/tmp/pi-mono` (`--depth 50`). Findings below are from source, not READMEs alone.

### Scale, immediately

| | DeepSeek Harness | Pi |
|---|---:|---:|
| workspace packages | **227** | **10** |
| plugin framework | vendored Cordis (DI + typed events + reversible effects) | none — a plain runner |
| extension unit | a Cordis plugin mounted in a config tree | a `.ts` file exporting a default function |
| user config | layered YAML patch over a plugin tree (`cordis.patch.yml`) | `settings.json` + auto-discovered files |

These are two genuinely opposite answers to the same question. That is why comparing them is useful.

---

## 2. DeepSeek Harness (`dsh`)

### 2.1 The irreducible core

**There isn't one — deliberately.** From `docs/architecture.md:13`:

> "There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads."

The agent loop, the model adapter, the tool registry, and the session log are all plugins. What is left underneath is **Cordis**, and Cordis owns exactly four things (`docs/cordis-primer.md:7-13`):

1. **Contexts as a service repository.** A plugin claims a stable key (`ctx.tools`, `ctx.llm`, `ctx.sessions`). Consumers resolve by key, never by import.
2. **`inject`-declared dependencies.** A plugin naming `inject: ['sessions']` doesn't run until `ctx.sessions` exists. *Load order is derived, never hand-sequenced.*
3. **Typed events via TypeScript declaration merging.** Each service `declare module`-extends a global `Events` interface.
4. **Registrations are reversible effects.** Everything installed via `ctx.effect()` / `ctx.on()` unwinds on unload.

What Cordis explicitly refuses to own: any product concept. It has no notion of a model, a tool, a session, or a turn.

What *dsh* refuses to own at the core layer: persistence (`packages/core/session/src/index.ts:791` — *"Persistence is intentionally not implemented here — persistence plugins subscribe to `session/event` and flush on `session/flush`"*), UI, transport, and policy.

### 2.2 Composition: profiles → bundles → patches

A running `dsh` is a plugin tree assembled at boot from ordered layers:

```
[] → dsh-base rows → dsh-web-app rows → profile cordis.patch.yml → home patch → --patch overlay
```

- A **bundle** is a distribution format for config rows + the code they mount.
- A **profile** stacks bundles and holds the user's patch file.
- A patch targets a row **by id** and replaces its whole config, or inserts new rows.

`dsh --profile web --dump-config` prints the exact tree the machine boots, and **every printed row is patchable**. That is the operational payoff of "everything is a plugin": the boot graph is a data structure the user can read and edit, not a call sequence in a `main()`.

### 2.3 Plugin contract

```ts
// A plugin is an object implementing Service:
//   a function with optional `inject` and `apply(ctx)`,
//   or a Service subclass whose lifecycle Cordis mounts.
export const name = 'session-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context) => ctx.invariants.register(PACKAGE_NAME, install)
```

- **Lifecycle:** mount → `apply(ctx)` → returns/registers disposers → unload unwinds them in registration order. Every registration has a disposer; if teardown order matters, keep the related work in *one* effect (`cordis-primer.md:44`).
- **Ordering/priority:** listeners fire in registration order, which is itself determined by config-row order in the boot tree. `prepend: true` exists but is documented as an escape hatch only.
- **Veto/transform:** determined by the event's **dispatch mode**, which is part of its public contract:

| Mode | Awaited | Order | Returns |
|---|---|---|---|
| `emit` | no | registration order | no |
| `waterfall` | no | registration order | yes |
| `parallel` | yes | concurrent | no |
| `serial` | yes | registration order | yes |

`waterfall` is around-middleware: a listener gets `(...args, next)`; call `next()` to delegate, return without it to short-circuit. For single-decision events, short-circuiting *is* the design; an annotate-only listener must delegate. New harness events tag `@mode` in JSDoc, and **a generated catalog checks the declaration against the actual dispatch sites**.

- **Error isolation:** yes, and it is a named rule. `docs/defensive-patterns.md:23` — *"Contain callback exceptions in the dispatcher: a user-supplied listener that throws must not reject the promise it runs inside or starve the listeners after it."* Implemented literally in `SessionStore` (`invokeContainedSessionObservers`, session/index.ts:381) — per-listener try/catch plus a `.catch()` on any returned promise, both routed to `ctx.logger.warn`. One bad plugin cannot break the log.

### 2.4 Event model

Three domains, chosen by *durability*, not by convenience (`architecture.md:57-59`):

- **Session events** — durable facts appended to the append-only log, broadcast via `session/event`. Use when the fact must survive a reload.
- **Agent events** (`agent/*`) — carry a live `Agent`: inbox, step, status, request, validation, continuation. Use to observe or intercept work in flight.
- **Capability events** (`fs/*`, `tools/*`, `telemetry/*`) — attach policy and adapters to a seam without importing the loop.

Typed (declaration-merged, so a typo is a compile error), mode-tagged, and — crucially — **mapped**. `docs/event-producer-consumer.md` is a *generated* matrix (`scripts/gen-doc-graphs.ts`, 1487 lines) resolving every event's declaring file, dispatch mode, dispatchers, and listeners **from the TypeScript program**. Sixty-odd events, each with its listener list. An event with `-` in the Listeners column is visible on sight.

> **This is the single most directly applicable artifact for squadrant.** #542 was an event with an empty consumer set that nobody could see.

The turn flow itself is documented as a small grammar (`architecture.md:67-82`), with the durable/live split stated explicitly:

```
turn/start
  claim next-step input + one queued message
  -> agent/pre-step               reject | enter(messages)
     step/start
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, `tool/*` are **durable**; the rest are live extension points.

### 2.5 The session log — replay as an invariant, not a feature

`Session` is an append-only `SessionEvent[]` with `seq = log.length` as a hard contiguity contract. Reading `packages/core/session/src/index.ts`, the enforcement is aggressive:

- Every `append()` takes **one lossless JSON snapshot** of `data` in a single recursive pass (so "a stateful getter cannot supply one value to validation and another to storage", line 601), then deep-freezes it. Non-serializable data throws *at the append site*, not later at a backend flush.
- A **seed** (replay/fork/resume) is validated against the *same* invariants a live append is, so a bad seed can't construct a live log no backend could store (line 508-537).
- **"Model-visible means logged."** `architecture.md:96`: anything reaching a model request must be reconstructable from the log, *and a runtime invariant asserts it*. Consequence: a new model-visible input **requires a new session event type**. There is no side channel.
- Message history is a *projection* (`deriveMessages()`) over a "surface" — an ordered view maintained by per-event `surfaceOp` markers, cached per node, invalidated by generation counter on rewrite (compaction). Raw `assistant/chunk` events are kept so replay and UI fidelity survive compaction.

Fork, resume, transcripts, telemetry, and persistence are all *derivations of this one stream*. That is what makes them cheap.

### 2.6 How dsh proves reliability

Three mechanisms, in increasing order of what squadrant is missing.

**(a) Test tiers** (`docs/testing.md`): unit → coverage gate (**per-file 100%** on `packages/*/*/src`) → real-API e2e → keyless snapshot → browser snapshot. Three rules stand out and are transferable regardless of framework:

- *"Prefer the real implementation over a mock."* Mock only the expensive/non-deterministic boundary (LLM, network, clock); everything downstream stays real. "A hand-rolled stand-in proves the bridge moves bytes, not that the shipping tool behaves as asserted."
- *"Verify the world, not the self-report."* An e2e assertion re-runs the command or re-reads the file externally. "A keyword probe on the agent's own output lets a cheating agent pass."
- *"Test the real entry path."* A package `bin` runs the **built** `lib/bin.js` under plain `node` — "exposing failures tsx masks". And: *"A guard only guards if the regression actually fails it"* — introduce the regression, watch red, revert.

Also: *"An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on."*

**(b) Runtime invariants** — `packages/runtime-diagnostics/invariants`. This is the mechanism that would have caught #542.

Every workspace package publishes a `./invariant` companion registering its **full npm package name** with `ctx.invariants`. An enabled companion runs in its own child Cordis fiber and receives `fail(message)`, which throws a package-attributed `InvariantError`. Config is `{ enabled, package_allowlist, package_blocklist }` — regex over package names — so invariants ship *in production* and are selectable per composition.

The session companion (`packages/core/session/src/invariant.ts`) maintains a per-session trace — `lastSeq`, `openTurn`, `openStep`, `nextTurn`, `nextStep`, `pendingCalls: Set<CallId>` — and validates every candidate event **before commit** by listening to `internal/dispatch`, then applies the staged transition on `session/event`. It asserts, among others:

```
tool/result for <callId> with no prior tool/call in this step
step/end … pendingCalls.clear()
session/event reached publication without matching pre-commit validation
```

**That is literally the #542 shape, checked.** A `tool/call` that never gets its `tool/result` is a trace the invariant owns.

The enforcement of the *enforcement*: `pnpm run verify-package-invariants` walks every workspace package and **rejects unexplained empty installers**, non-empty installers that ignore the reporter, wrong registration names, and incomplete export/dependency wiring. A package with no plausible runtime relationship must write a `No runtime invariant:` comment saying *why*. You cannot quietly opt out.

**(c) Named defect classes** — `docs/defensive-patterns.md`, 33 lines, seven rules, each one a bug that actually shipped:

1. Report orthogonal outcomes independently (a process can time out **and** exit 0).
2. Honor public contracts on both sides (normalize N failure representations before returning).
3. **Async state is not synchronous state** — never treat a status transition as the result of one message; an automation caller must define its own interval, and "if the awaited transition can never occur, the wait hangs, so handle the 'nothing to wait for' branch explicitly."
4. Dispose must reach quiescence, not just request it (kill → **await** done; close listener registries *before* killing so late completions stay silent).
5. Contain callback exceptions in the dispatcher.
6. Never hand untrusted output the ambient environment or predictable paths.
7. Unlink link-shaped paths.

Rules 3 and 4 are squadrant's exact recurring bug classes (#492, #542, #704, #589, orphaned processes).

### 2.7 The hooks answer — the most important structural lesson

dsh consumes **the same** Claude Code / Codex `hooks.json` protocol squadrant does. Its structure (`packages/hooks/README.md:5`):

> "The canonical extension surface itself is the harness's typed interception points; a 'native hook' is just an ordinary Cordis plugin on those extension points. These packages are the **bridges** that translate the external shell-hook protocol onto that same surface."

So:

- `hook-protocol/` — a **library**, not a plugin. Registers nothing, injects nothing. Owns the dialect-neutral half: matcher validation, `runHook`, `parseHookOutput`, `mergeHookOutputs` (precedence deny > ask > allow), detached-run quiescence.
- `hooks-claude-code/`, `hooks-codex/` — plugins owning only what differs: the per-event stdin payload, the dialect env, and the mapping from the neutral `HookOutput` onto a typed decision.
- Both bridges appear in the generated event matrix as **listeners** on `agent/pre-step`, `agent/session-start`, `agent/turn-stopping`, `tools/pre-execute`, `tools/post-execute` — the *same* extension points a native plugin uses.

And the durable side: `hook/invoked` and `hook/result` are declaration-merged session events **paired by `handlerId`**, and `dsh-hook-protocol`'s invariant companion checks that pairing. An unpaired hook invocation is a loud failure, not a silently stuck flag.

Compare squadrant, below.

### 2.8 dsh file map

| File | Lines | Why it matters |
|---|---:|---|
| `docs/architecture.md` | 131 | The whole design in one page: Cordis, profiles/bundles, event domains, turn grammar, "where new behavior goes" table |
| `docs/cordis-primer.md` | 44 | The plugin contract in five bullets + the dispatch-mode table |
| `docs/event-producer-consumer.md` | 79 | **Generated** event → mode → dispatchers → listeners matrix. The artifact to copy |
| `docs/defensive-patterns.md` | 33 | Seven named bug classes, each one shipped once |
| `docs/testing.md` | 49 | Tier policy + "verify the world, not the self-report" |
| `packages/core/session/src/index.ts` | 1157 | Append-only log, snapshot-and-freeze on append, seed validated like an append, surface projection |
| `packages/core/session/src/invariant.ts` | 250 | Per-session turn/step/call trace; pre-commit validation via `internal/dispatch` |
| `packages/runtime-diagnostics/invariants/` | 200 + README | The registry: package-owned checks, allow/blocklist, `InvariantError` |
| `packages/hooks/hook-protocol/` | ~106 (runner) | External hook protocol as a *library*; bridges are plugins on the native surface |
| `packages/core/agent-loop/src/index.ts` | 713 | The default driver — itself replaceable from config |
| `scripts/gen-doc-graphs.ts` | 1487 | Resolves the event/seam graphs from the TS program so docs cannot drift |

---

## 3. Pi (`badlogic/pi-mono`)

### 3.1 The irreducible core

Pi's core is small and *named*: `@earendil-works/pi-agent-core` (`packages/agent`) — "agent runtime with tool calling and state management". Under it, `@earendil-works/pi-ai` is a unified multi-provider LLM API. `@earendil-works/pi-coding-agent` is the product built on top.

The core owns: the agent loop, tool dispatch, the conversation tree, the session store, and compaction. Its harness spec (`packages/agent/docs/harness.md`, 2941 lines) reads like a database paper — write-once entries plus registers, transactions, an explicit operation state machine with a program counter, checkpoints, restore.

What Pi's core explicitly refuses to own (README, verbatim):

> "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it. If you need stronger boundaries, containerize or sandbox Pi."

That is a real, disciplined non-goal — the opposite of dsh, which ships `ctx.sandbox` and an approval policy in `dsh-base`. Pi also has no plugin framework, no DI container, and no service registry.

### 3.2 Plugin contract — a file, not a framework

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => { /* … */ });
  pi.registerTool({ /* … */ });
  pi.registerCommand("name", { /* … */ });
  pi.registerShortcut("ctrl+x", { /* … */ });
  pi.registerFlag("my-flag", { /* … */ });
}
```

- **Discovery:** auto-loaded from `~/.pi/agent/extensions/*.ts`, `.pi/extensions/*.ts` (project-local, **only after the project is trusted**), plus `settings.json` `extensions` / `packages` arrays. Loaded via [jiti] — TypeScript with no build step.
- **Distribution:** `pi install npm:@foo/bar@1.0.0 | git:github.com/user/repo@v1 | ./local/path`; `-e` for a throwaway single run. Packages bundle extensions, skills, prompt templates, and themes under a `pi` key in `package.json`.
- **Lifecycle:** a default factory, sync or async (awaited before `session_start`). Explicit rule: *"Do not start background resources such as processes, sockets, file watchers, or timers from the factory"* — defer to `session_start`, and register an **idempotent** `session_shutdown` handler.
- **Ordering:** extension load order, then handler registration order within an extension. No priority mechanism. Deliberate.
- **Veto/transform:** per event type, hand-rolled in the runner:
  - *Fold* — `emitMessageEnd` threads `currentMessage` forward through each handler (`runner.ts:834-873`), with a role-change guard that rejects the mutation and reports an error rather than corrupting the message.
  - *Cancel* — `session_before_*` events short-circuit on the first `{ cancel: true }` (`runner.ts:816`).
  - *Own the decision* — `project_trust`: the first handler returning `"yes"`/`"no"` wins and suppresses the built-in prompt; `"undecided"` delegates.
- **Error isolation:** every handler invocation is individually wrapped:

```ts
try { const handlerResult = await handler(event, ctx); /* … */ }
catch (err) {
  this.emitError({ extensionPath: ext.path, event: event.type, error: message, stack });
}
```

`emitError` fans out to a registered `ExtensionErrorListener` set (surfaced in the TUI). The loop continues. Same outcome as dsh's containment rule, one-tenth the machinery.

### 3.3 Event model

Two separate things, and the distinction matters:

**(a) The extension event set** — ~40 stringly-typed events, but exhaustively documented as a lifecycle diagram (`docs/extensions.md:277-349`) that a human can hold in their head:

```
project_trust → session_start → resources_discover
user prompt → input → before_agent_start → agent_start
  ├ turn_start → context → before_provider_headers → before_provider_request
  │             → after_provider_response
  │   ├ tool_execution_start → tool_call (can block) → tool_execution_update
  │   │ → tool_result (can modify) → tool_execution_end
  │   └ turn_end
  └ agent_end → agent_settled
```

Note the annotations in the source diagram: `(can intercept, transform, or handle)`, `(can block)`, `(can modify)`, `(can cancel)`. The *capability* of each hook point is documented next to the hook point. Types live in `extensions/types.ts` (1769 lines) — the entire contract is one readable file.

**(b) The internal harness bus** — `packages/agent/src/harness/events.ts`, **102 lines, two events**: `run_start` and `run_end`. That is the whole thing.

Its doc comment is a design statement:

> "Register a passive listener for future events and return its unsubscribe function. Earlier events are not replayed and no current-state snapshot is provided; **use a lane or session watch for both**."

Pi refuses to make the bus the state model. State lives in the session tree; the bus is a thin notification. The one subtlety it *does* handle is the `watch()` API: capture a snapshot, buffer events until `start()`, then flush **while still in buffering mode** so reentrant emissions preserve order. Snapshot + gap-free replay from the snapshot point, in ~25 lines.

### 3.4 Durable state — JSONL tree

Sessions are JSONL at `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`. One JSON object per line, `type`-discriminated. Entries form a **tree** via `id`/`parentId`, so branching happens in place without new files. A `version` field with automatic forward migration (v1 linear → v2 tree → v3 `hookMessage` renamed to `custom`).

The harness spec's storage model is write-once entries plus mutable named registers, with transactions and a checkpoint procedure — the abstract of "why write-once plus registers" is §1.8. Backends: memory, JSONL, SQLite behind one interface.

### 3.5 How Pi proves reliability

- **Contract conformance suites shipped as a package export.** `@earendil-works/pi-telemetry/testing` exports `createTelemetryAdapterConformance(fixture)` — a runner-independent suite of grouped cases. Any adapter (OpenTelemetry, Sentry, logs, custom) runs the *same* suite against itself by supplying a fixture that returns a fresh context and normalized finished spans. It checks single admission, result and rejection identity, status, attribute merging, event ordering, inert post-settlement calls, nested and concurrent parentage.
  → **The seam ships its own test suite.** An implementer proves conformance without the core.
- **Vendor-neutral contracts with an explicit no-op.** `NOOP_TELEMETRY_CONTEXT` plus an `InMemoryTelemetryContext` reference. "No exporter, global current-span state, or dependency on a telemetry backend." Telemetry contexts are passed **explicitly** — no ambient globals.
- **A faux provider harness.** `packages/coding-agent/test/suite/harness.ts` — "No real provider APIs, keys, or paid tokens." (Note: the exact inverse of dsh's "we are DeepSeek, do not ration real-API tests." Both are internally consistent with who is paying for inference.)
- **Named regression files.** `test/suite/regressions/<issue-number>-<short-slug>.test.ts`. Every bug gets a permanent, traceable test.
- **Agent-facing rules as code discipline.** `AGENTS.md` is unusually strict: no `any`, no inline imports, erasable TypeScript only, read files in full before wide-ranging changes, never `git add -A` (because multiple pi sessions run in one cwd concurrently and would stomp each other).

### 3.6 Pi file map

| File | Lines | Why it matters |
|---|---:|---|
| `packages/agent/docs/harness.md` | 2941 | Implementation spec: storage model, conversation tree, operation state machine, interpreter, restore |
| `packages/agent/src/harness/events.ts` | 102 | **Two** events. The bus is a notification, not the state model. `watch()` = snapshot + gap-free buffered replay |
| `packages/agent/src/agent-loop.ts` | 796 | The loop the core actually owns |
| `packages/coding-agent/docs/extensions.md` | 3002 | The extension contract, with per-hook-point capability annotations |
| `packages/coding-agent/src/core/extensions/types.ts` | 1769 | Whole extension surface as one typed file |
| `packages/coding-agent/src/core/extensions/runner.ts` | 1236 | Sequential dispatch, per-handler try/catch → `ExtensionError` listeners, fold/cancel per event kind |
| `packages/coding-agent/src/core/extensions/loader.ts` | 806 | Discovery, trust gating, jiti loading |
| `packages/coding-agent/src/core/session-manager.ts` | 1716 | JSONL tree, versioned, migrating |
| `packages/telemetry/src/testing/conformance.ts` | 315 | **Seam ships its own conformance suite** |
| `packages/coding-agent/docs/packages.md` | 228 | npm/git/path distribution, pinning, project-vs-user scope |

---

## 4. Head-to-head

| Axis | DeepSeek Harness | Pi |
|---|---|---|
| Core | none privileged; Cordis underneath | a real, named, small core (`pi-agent-core`) |
| Plugin unit | Cordis plugin in a config tree | a `.ts` file with a default export |
| Wiring | `inject` service keys; order derived | load order; order is registration order |
| Events | typed via declaration merging, `@mode`-tagged, **generated producer/consumer map** | stringly-typed union, documented as one lifecycle diagram |
| Dispatch | 4 modes (`emit`/`waterfall`/`parallel`/`serial`) as public contract | hand-rolled per event kind (fold / cancel / own-the-decision) |
| Error isolation | per-listener containment, logged | per-handler try/catch → `ExtensionError` listener set |
| Teardown | reversible effects unwind on unload | idempotent `session_shutdown`, no background work in factories |
| Durable state | append-only `SessionEvent` log; "model-visible means logged" enforced by invariant | JSONL entry tree, versioned + migrating; write-once + registers |
| Proof | per-package **runtime invariants** + 100% per-file coverage + snapshot tiers | conformance suites shipped with seams + faux-provider harness + named regressions |
| Config | layered patch over a dumpable plugin tree | `settings.json` + auto-discovery |
| Cost | 227 packages; needs a framework primer to contribute | 10 packages; a new contributor reads one types file |

**The honest read:** dsh's design is correct at a scale squadrant will never reach, and its cost is a vendored DI framework plus a doc-generation pipeline. Pi's design is what a small team can actually maintain, and its cost is that ordering and cross-cutting policy are *conventions*, not mechanisms.

Squadrant is a 6-package daemon maintained by one person. **The shape to copy is Pi's. The specific mechanisms to copy are dsh's.**

---

## 5. Squadrant today

### 5.1 The current shape

```
shared ◄ core ◄ {agents, workspaces, web} ◄ cli
```

Three declared plugin slots — runtime (cmux), workspace (obsidian), notifier — plus two more seams that exist but aren't framed as slots: `AgentDriver` (`@squadrant/agents`: claude / codex / opencode / gemini) and `LifecycleSource` (`packages/core/src/lifecycle-source.ts`).

What squadrant already has right, and should keep:

- **One typed event union.** `ControlEvent` in `packages/shared/src/types/control.ts` — 26 discriminated variants. Genuinely good.
- **One reducer chokepoint.** `applyEvent(project, event)` at `packages/core/src/daemon/reduce.ts:323`, guarded by an exhaustive known-type set that throws `unknown event type '<x>' — not a valid ControlEvent` at the socket boundary.
- **A port for lifecycle sources** with an explicit reconciliation reducer (`reduceLifecycle`, 4 documented rules: agent-origin authoritative, scans can't assert `needsInput`, agent-set `needsInput` sticky, stale scan can't regress).
- **A control/captain channel** cutover (#667) replacing screen-scraping with native agent receipts for `claude`.

### 5.2 Where event tracking actually lives — and where it leaks

**Five** independent paths currently produce lifecycle truth:

| # | Path | File | Emits |
|---|---|---|---|
| 1 | cmux events-bridge | `packages/workspaces/src/cmux-daemon/events-bridge.ts` | `task.progress` (`note: "agent.hook.PreToolUse"` / `"agent.hook.PostToolUse"`), `task.turn.completed` |
| 2 | NativeHookSource (`~/.claude/settings.json`) | `packages/workspaces/src/native-hooks/native-hook-source.ts` + `packages/cli/src/commands/hooks.ts` | `task.progress` (`note: "pre-tool-use"`), `task.first-turn.confirmed`, `task.blocked`, `task.input.requested`, `task.session.ended` |
| 3 | crew `_hook` bridge | `packages/agents/src/interactive/claude.ts:340` | `task.progress` (`note: event.toLowerCase()` → `"posttooluse"`, `"subagentstop"`, `"notification"`) |
| 4 | CmuxStoreSource + pid sweep | `packages/workspaces/src/cmux-daemon/cmux-store-source.ts`, `packages/core/src/liveness.ts` | `origin: "scan"` snapshots |
| 5 | Pane scraping | `packages/core/src/crew-pane-reader.ts`, `packages/core/src/daemon/interactive-probe.ts` | `task.warn`, delivery verdicts, idle inference |

**The leak is not that there are five. It is that each one performs its own semantic classification at ingress, and the classification vocabulary is a bare string.**

Concretely, the `pendingTool` open/close pairing — the discriminator the watchdog uses to tell a hung tool call from a quiet thinking turn — is keyed on `ControlEvent.note` string equality across three feeds with three different spellings of the same fact:

| Fact | Path 1 (cmux bridge) | Path 2 (native hook) | Path 3 (crew `_hook`) |
|---|---|---|---|
| PreToolUse | `"agent.hook.PreToolUse"` → **opens** window | `"pre-tool-use"` → does **not** open | `null` unless AskUserQuestion |
| PostToolUse | `"agent.hook.PostToolUse"` → closes *(added by #542 today)* | not installed at all (`native-hook-source.ts:18`) | `"posttooluse"` → closes |

`nextPendingTool` (`packages/core/src/state-machine.ts`) matches those literals. A window opened by path 1 could, before today, only be closed by path 1 — which had no PostToolUse case. **#542 was structurally guaranteed.**

Four compounding gaps:

1. **No durable event log.** `TaskRecord` is a folded snapshot; the `ControlEvent` that produced it is discarded. There is nothing to replay, nothing to diff, no way to answer "what actually arrived" after the fact. Both dsh and Pi treat the log as the source of truth and the state as a projection. Squadrant has only the projection.
2. **Classification at ingress.** `deriveRunState()` collapses a raw fact (`agent.hook.PostToolUse`) into an interpretation (`"working"` / `"idle"` / `null`) *inside the adapter*, and `null` means silently discard. Provenance is lost at the boundary; an unrecognized fact is indistinguishable from an irrelevant one.
3. **No invariant layer.** Nothing asserts "an opened `pendingTool` is eventually closed," "`task.turn.completed` follows `task.turn.started`," or "a source that reported `running` at T reports again within budget."
4. **No producer/consumer map.** There is no artifact — generated or otherwise — that says which `ControlEvent` variants each source emits and which consumers read them. An event with zero producers or zero consumers is invisible.

Symptom history, all the same family: #492 (idle flood from racing turn-end assertions), #542 (dropped pairing), #704 (pane-scraped error text terminalizing a live crew), the 2026-08-13 "three false lifecycle signals in one session," the recurring memory rule *"verify with ps/git before acting on ANY crew signal."* **When the operator's own memory says "never trust the signal," the signal layer is the defect.**

---

## 6. Proposal — `@squadrant/events`, one self-owned module

### 6.1 Goal and non-goals

**Goal:** one module that owns "what happened to a crew," is provable in isolation without a daemon or cmux, and plugs into the daemon as **one** `LifecycleSource`.

**Non-goals** (state them, or this becomes a rewrite):

- Not a plugin framework. No DI container, no service registry, no Cordis. Pi's shape.
- Not a replacement for `ControlEvent` or the state machine. It sits *in front* of `applyEvent`.
- Not a new transport. It consumes the sources that already exist.
- Not a big-bang cutover. It runs in shadow, replayed against recorded fixtures, until it provably matches or beats today's verdicts.

### 6.2 The core idea: separate **facts** from **verdicts**

Today: `raw frame → classify → ControlEvent`, with the classifier inside each adapter.

Proposed: `raw frame → normalize to a typed AgentFact → append to log → one reducer → ControlEvent`.

An `AgentFact` is a *thing that happened*, carrying its provenance. It is never `null`. An unrecognized fact is recorded as `{ kind: "unknown", raw }` and **counted** — it can be seen, alerted on, and turned into a test. That single property is the whole fix for #542.

```ts
// packages/events/src/fact.ts  — the one vocabulary

/** Which adapter observed this, for reconciliation + audit. */
export type FactSource = "cmux-events" | "claude-native-hook" | "crew-hook"
                       | "control-channel" | "cmux-store" | "pid-sweep" | "pane";

/** How much the fact can be trusted. Mirrors today's LifecycleSnapshot.origin. */
export type FactOrigin = "agent" | "scan" | "inferred";

export interface FactEnvelope {
  seq: number;            // contiguous from 0 per crew — the replay contract
  taskId: string;
  at: number;             // epoch ms
  source: FactSource;
  origin: FactOrigin;
  /** Adapter-specific correlation echo, so a mis-correlation is auditable. */
  hint?: CorrelationHint;
}

export type AgentFact = FactEnvelope & (
  | { kind: "session.started";  pid?: number; sessionId?: string }
  | { kind: "session.ended" }
  | { kind: "prompt.submitted"; first: boolean }
  | { kind: "turn.ended" }
  | { kind: "tool.started";     callId: string; tool: string }
  | { kind: "tool.ended";       callId: string; tool?: string }
  | { kind: "subagent.started"; callId: string }
  | { kind: "subagent.ended";   callId: string }
  | { kind: "input.requested";  question: string; options?: string[] }
  | { kind: "permission.requested"; question: string }
  | { kind: "receipt";          delivered: boolean; ref?: string }
  | { kind: "process.observed"; alive: boolean; pid?: number }
  | { kind: "unknown";          raw: string }      // ← never dropped
);
```

Three deliberate choices:

- **`callId` on `tool.started` / `tool.ended`.** Today's pairing is by *string equality on a note*. Pairing by an explicit id is what dsh's session invariant does (`pendingCalls: Set<CallId>`) and what makes "an unpaired call" a checkable statement. If a source can't supply a call id, the adapter synthesizes one (`${source}:${tool}:${seq}`) and marks it — a synthesized id is honest about being weak; a missing one is not.
- **`unknown` is a fact.** Adapters translate; they never classify-and-discard.
- **`origin: "inferred"`** is new (pane scraping). It exists so the reducer can treat scraped conclusions as strictly weakest — today they enter the same channel as hook facts, which is how #704 happened.

### 6.3 Module shape

```
packages/events/                      # @squadrant/events — depends only on @squadrant/shared
  src/
    fact.ts          # AgentFact union + envelope. The vocabulary. ~120 lines
    log.ts           # append-only per-crew log: seq contiguity, JSONL sink, bounded ring in memory
    reduce.ts        # PURE: (CrewTrace, AgentFact) -> { trace, emits: ControlEvent[] }
    invariant.ts     # PURE: (CrewTrace, AgentFact) -> Violation[] ; the pairing/ordering rules
    adapters/
      cmux-events.ts        # cmux frame     -> AgentFact
      claude-native-hook.ts # hooks.json sub -> AgentFact
      crew-hook.ts          # crew _hook     -> AgentFact
      control-channel.ts    # native receipt -> AgentFact
      scan.ts               # store + pid    -> AgentFact
      pane.ts               # scrape         -> AgentFact(origin:"inferred")
    source.ts        # the ONE LifecycleSource facade the daemon registers
  fixtures/
    *.jsonl          # recorded real fact streams + their expected ControlEvent output
  tests/
    adapters.spec.ts      # per-adapter: raw frame in, exact AgentFact out
    reduce.spec.ts        # pure reducer table tests
    invariant.spec.ts     # every violation, positive AND negative
    replay.spec.ts        # fixture -> reduce -> assert exact ControlEvent stream
    conformance.ts        # EXPORTED suite any adapter runs against itself (Pi's pattern)
```

Rules that keep it honest:

- `reduce.ts` and `invariant.ts` are **pure** — no clock, no fs, no process. Time enters as a field on the fact.
- Adapters have **no** access to the log or the reducer. Frame in, fact out. Individually testable with zero infrastructure.
- `source.ts` is the only file that knows the daemon exists.

### 6.4 The invariants (this is the deliverable that pays for the module)

Copied in spirit from `dsh-session/invariant.ts`. A `CrewTrace` per crew: `lastSeq`, `openTurn`, `pendingCalls: Map<callId, {tool, since}>`, `lastFactAt`, `lastAgentFactAt`.

| # | Invariant | Catches |
|---|---|---|
| I1 | `seq` strictly increases per crew | dropped/reordered frames — the #542 *class*, generically |
| I2 | `tool.ended` names a `callId` in `pendingCalls` | mis-paired closers, wrong-spelling closers |
| I3 | `turn.ended` with a non-empty `pendingCalls` is a **violation**, not a veto | **#542 exactly.** Today this silently vetoes forever |
| I4 | `pendingCalls` entry older than the stall budget → violation *before* the watchdog terminalizes | false CREW STALLED (#542) |
| I5 | An `origin:"inferred"` fact never produces a terminal `ControlEvent` on its own | **#704** — pane text terminalized a live crew |
| I6 | `unknown` fact rate > 0 over a window → loud warning naming source + raw | any future dropped-frame bug, on first occurrence |
| I7 | Two sources disagree on liveness within N ms → violation carrying both | the 2026-08-13 three-false-signals session |
| I8 | Any `ControlEvent` the reducer emits is reproducible by replaying the log prefix | dsh's "model-visible means logged", squadrant flavour |

Failure mode, following dsh: a violation throws a `LifecycleInvariantError` **in tests and in shadow mode**; in production it logs at warn with the fact + trace and increments a counter surfaced in the daemon snapshot and the web dashboard. Configurable via `{ enabled, strict }` — the same enable/allowlist shape as `ctx.invariants`.

I3 deserves emphasis. Today, `turn.ended` arriving with a stale `pendingTool` is the *normal* path into the bug: #492's veto suppresses the turn-end, forever, with no signal. Under I3 it is a **named, counted, visible violation** the first time it happens. #542 would have surfaced within one crew-hour instead of within months.

### 6.5 Proving it in isolation

Three tiers, all runnable without a daemon, without cmux, without a model.

**(a) Adapter unit tests.** Real captured frames → exact `AgentFact`. Every adapter also runs the **exported conformance suite** (Pi's telemetry pattern): supply a fixture that maps N canonical raw inputs to facts, and the suite checks the properties every adapter must satisfy — never returns `null`, always stamps `source` and `origin`, an unrecognized input yields `kind:"unknown"` and not a throw, `at` is monotonic within a stream, correlation hints round-trip. **A new adapter (gemini, codex app-server, a future agent) proves itself against the seam before touching the daemon.** That is the operator's "prove it works reliably, then plug it in," made mechanical.

**(b) Replayable fixture log.** A daemon flag (`SQUADRANT_FACT_LOG=1`) tees every `AgentFact` to `~/.config/squadrant/facts/<project>/<taskId>.jsonl`. Capture a real session — a crew that stalls, a crew that blocks, a crew that finishes — and it becomes a permanent fixture:

```
fixtures/542-stale-pending-tool.jsonl     # the real dropped-PostToolUse stream
fixtures/704-pane-error-text.jsonl
fixtures/492-idle-flood.jsonl
fixtures/happy-path-claude.jsonl
```

`replay.spec.ts` feeds each fixture through the pure reducer and asserts the exact emitted `ControlEvent` sequence plus the exact violation list. A regression is a *file*, not a hand-built mock — and it is the real bytes, which is dsh's "prefer the real implementation over a mock" and "verify the world, not the self-report" applied to a daemon.

Naming convention, from Pi: `fixtures/<issue-number>-<slug>.jsonl`.

**(c) Shadow-then-cut-over.** Precedent exists — that is exactly how `controlChannel` reached `claude: on` (#667). Run `@squadrant/events` alongside the current five paths, computing but not emitting; log every disagreement with the live verdict. Cut over per source when disagreements reach zero over a real workload. `opencode` stays in shadow, as it does today.

### 6.6 How it plugs in

One `LifecycleSource`, registered where the three are registered today (`packages/cli/src/squadrantd.ts`):

```ts
// before
ctx.lifecycleSources = [cmuxStoreSource, nativeHookSource, codexAppServerSource]
// plus: CmuxEventsBridge emitting ControlEvents directly
// plus: pane reader / interactive probe emitting directly

// after
ctx.lifecycleSources = [createEventsSource({
  adapters: [cmuxEvents, claudeNativeHook, crewHook, controlChannel, scan, pane],
  invariants: { enabled: true, strict: false },
  factLog: factLogPath,
})]
```

`createEventsSource` implements the existing `LifecycleSource` interface unchanged — `start(deps)`, `stop()`, `snapshot(taskId)`, `health()` — so `packages/core/src/daemon/start.ts` and the health aggregation need no change. `deps.report()` still feeds `reduceLifecycle`; `deps.resolve()` still owns correlation. The daemon's contract does not move.

The existing `reduceLifecycle` 4-state reconciliation **stays**. It is correct and already encodes the agent-vs-scan trust rules. What changes is that it now receives facts from one place that has already validated them, instead of from adapters that each independently decided what to keep.

### 6.7 Sequencing (small, provable steps)

1. `fact.ts` + `log.ts` + the exported conformance suite. No wiring. **Zero risk.**
2. Adapters, one per PR, each with unit tests + conformance. Still no wiring.
3. `SQUADRANT_FACT_LOG=1` tee behind a flag; capture real fixtures for #542, #704, #492 and a happy path.
4. `reduce.ts` + `invariant.ts` pure; `replay.spec.ts` green against those fixtures.
5. Shadow mode: `createEventsSource` registered, computing, logging disagreements, emitting nothing.
6. Cut over `claude` first (the proven agent), leave the others in shadow.
7. Delete the direct-emit paths from `CmuxEventsBridge` and the pane reader **only after** the fixtures prove the replacement.

Step 4 alone — a pure reducer with fixture replay — retires the "verify with ps/git before acting on ANY crew signal" memory rule for the covered cases. That is the real prize.

---

## 7. The plugin boundary for squadrant

Pi's shape, dsh's mechanisms. Concretely:

| Layer | DeepSeek Harness | Pi | **squadrant — proposed** |
|---|---|---|---|
| **Core (never a plugin)** | Cordis only | agent loop, tool dispatch, session tree, compaction | daemon + socket + `applyEvent` chokepoint + state machine + watchdog + **`@squadrant/events`** + `ControlEvent` vocabulary |
| **Seams (typed contract, N impls)** | ~40 `ctx.*` services | `ExecutionEnv`, `TelemetryContext`, session backends, providers | `AgentDriver`, `LifecycleSource` *(now one)*, `FactAdapter` **(new)**, runtime, workspace, notifier |
| **Plugins (drop-in, out-of-tree)** | everything, incl. the agent loop | `.ts` extension files, npm/git packages | fact adapters, notifiers, skills, routing rules — **not** the reducer |
| **Extension surface** | typed Cordis events, 4 dispatch modes | ~40 event types, hand-rolled fold/cancel | `ControlEvent` union + a small documented set of interception points |
| **Composition** | layered YAML patch over a dumpable plugin tree | `settings.json` + auto-discovery | `~/.config/squadrant/config.json` + `projects/<name>.json` deep-merge *(already exists)* |
| **Proof** | per-package runtime invariants, generated event map, 100% per-file coverage | conformance suites shipped with seams, faux provider, named regressions | **all three, scoped:** invariants for the fact reducer, conformance for `FactAdapter`, JSONL fixtures for replay |
| **Error isolation** | per-listener containment | per-handler try/catch → error listener set | per-adapter containment: a throwing adapter yields `kind:"unknown"` + a violation, never kills the source |

**What stays core, permanently:** the reducer. Both harnesses put the state transition in the core and let plugins observe or annotate it. Squadrant's `reduce`/`state-machine`/`watchdog` triangle is the product; it must not become pluggable. The correct extension point is *what facts arrive*, not *what they mean*.

**What becomes a plugin:** every `FactAdapter`. Adding gemini or a new cmux version should be one file plus a conformance run, with no daemon change. That is the concrete cash-out of the multi-agent direction (`CLAUDE.md`: *"does this work for non-Claude agents too?"*).

**Two cheap artifacts worth stealing outright, independent of the module:**

1. **A generated producer/consumer map for `ControlEvent`.** dsh's `scripts/gen-doc-graphs.ts` is 1487 lines because it resolves a 227-package TS program. Squadrant's equivalent — walk `packages/*/src` for `type: "task.…"` literals, group by emitter and by reducer case — is maybe 150 lines, and it makes "this variant has no producer" and "this variant has no consumer" visible on every build. **This is the artifact that most directly prevents the next #542**, and it does not require the module.
2. **`docs/defensive-patterns.md`, squadrant edition.** dsh's is 33 lines and every rule is a shipped bug. Squadrant has a richer catalogue already scattered across memory files: async status ≠ per-message result (#492, the 2026-08-13 session), dispose must reach quiescence (orphaned `claude -p` sessions, crews not killing vitest), never trust a never-matching marker as positive signal (#499), a `cancelled` record is bookkeeping — the process is still alive (#697), `bootout` loses to `KeepAlive` (2026-08-20). Writing these down as *rules* rather than *memories* makes them reviewable.

---

## 8. What NOT to copy, and why

**From DeepSeek Harness:**

- **Cordis / DI + service-key resolution.** 227 packages need dependency-ordered mounting; 6 do not. Squadrant's DAG is already one-way and enforced. Adopting Cordis buys load-order derivation squadrant gets for free from ES imports, and costs every future contributor a framework primer. `docs/cordis-primer.md` exists because you cannot read dsh without it.
- **"Everything is a plugin," including the loop.** The daemon's state machine *is* squadrant's product. Making it swappable from config makes every bug report unanswerable ("which tree were you booting?"). dsh can afford this because it has a generated config catalog and `--dump-config`; squadrant would just lose the ability to reason about a live system.
- **The profile/bundle/patch layering.** Solves plugin distribution at ecosystem scale (there is a `dsh-plugin` GitHub topic with dozens of third-party repos). Squadrant has one user. Layered per-project config already exists and is sufficient.
- **100% per-file coverage as a gate.** Sound in a repo with a full-time team; in a one-person repo it converts into test-shaped filler around code the gate should have flagged for deletion. Adopt the *reasoning* — "an uncovered line is often dead code" — not the number.
- **"Do not ration real-API tests."** Explicitly justified by "we are DeepSeek." Squadrant pays retail. Copy Pi's faux-provider harness instead; keep a small number of real-agent smoke tests on the throwaway TEST project.
- **The 1487-line doc-graph generator.** Copy the *output shape*, not the implementation.

**From Pi:**

- **No permission system, "containerize if you need boundaries."** Correct for a single-user CLI; wrong for squadrant, which spawns crews that write to real repos. Squadrant's approval flow, `--permission-mode auto`, the never-`--dangerously-skip-permissions` rule, and the #556 captain-memory write gate are load-bearing. Keep them.
- **Extensions as arbitrary auto-loaded `.ts` from the cwd.** Pi gates this behind project trust, and its own docs warn "extensions run with your full system permissions." Squadrant runs a **daemon** with a socket, other people's repos, and Telegram inbound. A fact adapter should be a compiled workspace package or an explicitly configured path — not an auto-discovered file in whatever directory a crew happens to be in. Given the known #321 chat-membership gap, do not add a second unauthenticated code-execution surface.
- **jiti / runtime TypeScript loading.** Squadrant ships a bundled `dist/index.js` + `dist/squadrantd.js` via tsup. Runtime TS loading in the daemon would re-open the module-resolution class the repo already learned the hard way (NodeNext `.js` extensions, #344; the dist-relative `package.json` invariant, #363).
- **The 2941-line harness spec as a template.** Pi's spec earns its length by specifying a storage engine. Squadrant's event module is a reducer plus a vocabulary; a spec that long would be procrastination wearing a lab coat. The right length is this document's §6.

**From both — the meta-warning:**

Both harnesses have a *whole team* maintaining the machinery that makes the machinery safe: dsh's `verify-package-invariants` + generated catalogs, Pi's conformance suites + regression naming discipline. Copying a mechanism without its enforcement gets the cost and not the benefit. If `@squadrant/events` ships invariants but nothing checks that new adapters register one, it degrades into commented-out asserts within two months — the same way #653/#654 found that captain rules never reached the system prompt.

**So: one enforcement rule, and only one.** Every `FactAdapter` must export a conformance fixture, and `pnpm test` fails if one doesn't. That's the whole governance layer. It is small enough to survive.

---

## 9. Summary

| Question | Answer |
|---|---|
| Which harness fits squadrant? | **Pi's shape** — a small named core, plugins as files against a typed surface, no framework |
| Which mechanisms are worth importing? | **dsh's**: runtime invariants, the generated producer/consumer map, "durable means logged", named defect classes. **Pi's**: seams that ship their own conformance suite |
| What is the smallest module? | `@squadrant/events` — one `AgentFact` vocabulary, N pure adapters, one pure reducer, one invariant set, JSONL fixtures, one `LifecycleSource` facade |
| What proves it? | Per-adapter conformance + fixture replay of real captured streams (#542, #704, #492) + shadow-mode disagreement logging before cutover |
| What must never become a plugin? | The reducer, the state machine, the watchdog, the `ControlEvent` vocabulary |
| Cheapest thing to do first, independent of everything above? | The **generated `ControlEvent` producer/consumer map** (~150 lines). It makes the #542 class visible without changing a line of runtime code |
| What not to copy? | Cordis/DI, everything-is-a-plugin-including-the-loop, 100% coverage gates, unrationed real-API tests (dsh); no-permission-system, auto-loaded cwd extensions, runtime TS loading (Pi) |

**One sentence:** squadrant does not need a plugin framework — it needs a durable, replayable, invariant-checked record of what its agents actually did, owned by one small module, and a build-time map proving every event has both a producer and a consumer.

---

## Appendix A — repos studied

| Repo | Ref | Location |
|---|---|---|
| `deepseek-ai/deepseek-harness` | default branch, `--depth 50`, 2026-08-27 | `/tmp/deepseek-harness` |
| `badlogic/pi-mono` | default branch, `--depth 50`, 2026-08-27 | `/tmp/pi-mono` |

Read-only. No changes made to squadrant source; this document and the companion diagram are the only files written.

## Appendix B — squadrant evidence cited

| Claim | Where |
|---|---|
| `deriveRunState` default → `null` → silent drop | `packages/workspaces/src/cmux-daemon/events-bridge.ts:58-68, 229` |
| #542 root cause & fix | commit `15ea2fe`, `packages/core/src/state-machine.ts` `nextPendingTool` |
| Three spellings of PostToolUse | `events-bridge.ts:217`, `packages/agents/src/interactive/claude.ts:372-376`, `packages/workspaces/src/native-hooks/native-hook-source.ts:18-32` |
| Native hook set excludes PostToolUse | `native-hook-source.ts:18`, `CLAUDE_HOOK_EVENTS` |
| Single ingress chokepoint + exhaustive type guard | `packages/core/src/daemon/reduce.ts:288, 323-325` |
| `ControlEvent` union, 26 variants | `packages/shared/src/types/control.ts:132-206` |
| `LifecycleSource` port + `reduceLifecycle` rules | `packages/core/src/lifecycle-source.ts:70-126` |
| No durable event log (TaskRecord is a fold) | `packages/core/src/store.ts`, `packages/core/src/daemon/reduce.ts` |
