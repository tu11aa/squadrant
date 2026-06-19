# Crew Effort — Global Tokenomics Dial

**Status:** Design / approved for planning
**Date:** 2026-06-15
**Author:** research side-session (brainstorm with user)
**Scope:** crew routing only

## Problem

Crew model selection today is fixed by `defaults.crewRouting.rules` (tier → `{agent, model}`)
and `defaults.roles.crew`. There is no single lever to say *"I have spare token budget
today, lean stronger"* or *"I'm low on budget, lean cheaper"* without hand-editing routing
rules each time.

The user wants exactly that: one global setting they flip based on how much token budget
they have on a given day:

- **balance** — normal working mode (today's behavior).
- **max** — more tokens available → bias crews toward the strongest model.
- **low** — fewer tokens available → bias crews toward cheaper agents/models.

This is a **tokenomics dial**, not a mechanical routing rewrite. The captain is the brain;
effort is a hint the captain honors when it spawns crews.

## Non-Goals

These were explicitly considered and rejected during brainstorming to keep the feature
simple (YAGNI):

- **No per-tier ladder.** Earlier drafts gave each routing rule `low`/`balance`/`max`
  columns. Rejected — too much config to maintain and reason about.
- **No mechanical transform in `resolveCrewRoute`.** Effort never rewrites a resolved
  model up or down a ladder in code. Routing rules stay untouched.
- **No effort on non-crew roles.** Captain / command / side stay pinned to opus (a
  deliberate, benchmark-backed decision). Effort is crew-only.
- **No change to the routed one-liner.** `routed: tier=… → agent/model (rule: "…")`
  stays exactly as today.

## Design

### 1. Storage

Add one optional field to `CockpitConfig.defaults`:

```ts
defaults: {
  // …
  /** Global crew tokenomics dial. Absent ⇒ "balance" (today's behavior).
   *  Biases the captain toward stronger ("max") or cheaper ("low") crew models. */
  effort?: "max" | "balance" | "low";
}
```

- **Absent ⇒ `balance`.** No migration, no backfill — every existing config behaves as
  today.
- `getDefaultConfig()` may set `effort: "balance"` explicitly for clarity, but readers
  must treat absent as `balance`.

A single resolver helper centralizes the absent-default:

```ts
// src/control/effort.ts
export type Effort = "max" | "balance" | "low";
export function resolveEffort(config: CockpitConfig): Effort {
  return config.defaults.effort ?? "balance";
}
```

### 2. Setter surfaces (three, for maximum ergonomics)

| Surface | Behavior |
|---|---|
| `cockpit effort <max\|balance\|low>` | Validates the value, writes `defaults.effort` via the existing `saveConfig` atomic path, prints confirmation + one-line meaning. |
| `cockpit effort` (no arg) | Prints the current effort and its meaning. Does not write. |
| `cockpit:set-effort` skill | The engine. Reads/writes `defaults.effort`, echoes the new mode and what it means for crew spawns. Portable to non-Claude agents via `AGENTS.md`. |
| `/cockpit-effort` | Thin Claude-Code slash alias that invokes `cockpit:set-effort`. Convenience only. |

Validation: only `max` / `balance` / `low` accepted; anything else is a usage error
listing the three valid values.

### 3. How the captain honors effort (crew-only)

Two complementary mechanisms — passive for durability, active for immediacy. The captain
template (`captain.claude.md`) is **hashed for session-freshness**, so the live effort
value is deliberately NOT written into it (would churn the hash and force a fresh session
on every toggle). The value lives in `config.json` and is read/pushed.

**Passive — `cockpit:captain-ops` skill gains an "Effort mode" section.** Before spawning
crews, the captain reads `defaults.effort` from config and biases its crew agent/model
choice:

- **max** — prefer the strongest model (claude/opus) for crew spawns.
- **balance** — use default crew routing rules unchanged.
- **low** — prefer cheaper agents/models (opencode, sonnet) for crews.

This is the durable instruction — survives restarts and context compaction because the
skill is re-read at session start and referenced throughout.

**Active — `cockpit effort <mode>` notifies the running captain.** When the setter runs,
it sends a relay message to the project's captain so a live session adjusts immediately
instead of waiting to re-read config on the next spawn:

```
🎚 effort → low: bias new crew spawns toward cheaper agents/models (opencode, sonnet).
```

The relay send is best-effort: if no captain is running, the setter still writes config and
prints a note that the change takes effect on next launch. (No hard dependency on a live
daemon/captain.)

### 4. Mode semantics (the captain's interpretation guide)

Plain-language directives, not a mechanical model table — the captain applies judgment
within the existing routing rules:

| Mode | Directive to the captain |
|---|---|
| **max** | Tokens are plentiful. Prefer claude/opus for crews; don't downshift for cost. |
| **balance** | Normal. Use the default crew routing rules as-is. |
| **low** | Conserve tokens. Prefer opencode / sonnet for crews; reserve opus for work that genuinely needs it. |

### 5. Precedence

Effort is the *weakest* signal — it only nudges the captain's default choice. Anything
more specific wins:

1. **Explicit `--agent` / `--model` on a spawn** → wins outright (unchanged).
2. **A specific routing-rule match the captain chooses to honor** → the captain weighs
   effort against the matched tier using its judgment.
3. **Effort directive** → the baseline lean when nothing more specific applies.

Because effort lives in the captain's reasoning (not in `resolveCrewRoute`), there is no
code-level precedence to encode beyond the existing explicit-flags-win rule.

## Affected surfaces

| File / artifact | Change |
|---|---|
| `src/config.ts` | Add `effort?` to `CockpitConfig.defaults`; optionally set `"balance"` in `getDefaultConfig()`. |
| `src/control/effort.ts` (new) | `Effort` type + `resolveEffort(config)` helper. |
| `src/commands/effort.ts` (new) | `cockpit effort [value]` get/set command. |
| CLI registration | Wire `effort` subcommand into the cockpit CLI entrypoint. |
| `plugin/skills/cockpit/set-effort/SKILL.md` (new) | `cockpit:set-effort` skill. |
| `/cockpit-effort` slash alias | Thin alias to the skill. |
| `cockpit:captain-ops` skill | Add "Effort mode" section to the crew-spawning playbook. |
| Relay send (existing `cockpit runtime send` path) | Setter pushes a one-line effort notice to the running captain. |

## Testing / success criteria

- `cockpit effort low` writes `defaults.effort: "low"`; `cockpit effort` then prints `low`
  + its meaning. (unit on the command; round-trips through `loadConfig`/`saveConfig`.)
- Invalid value (`cockpit effort turbo`) errors with the three valid options; config
  unchanged.
- Absent `defaults.effort` resolves to `balance` (unit on `resolveEffort`).
- Existing configs with no `effort` field load and behave identically to today (no
  migration side effects).
- Routing behavior (`resolveCrewRoute`) and the routed one-liner are byte-for-byte
  unchanged when effort is `balance` and untouched in code regardless of effort.
- `cockpit:captain-ops` skill text instructs the captain to read and honor `defaults.effort`
  for crew spawns only.
- Setter sends a relay notice when a captain is running; degrades gracefully (writes config
  + prints note) when none is.

## Open follow-ups (out of scope for v1)

- A `max` cap / safety rail if budget mode is ever made auto-driven (not now — the user
  sets it manually).
- Surfacing current effort in dashboard / status (nice-to-have; not required for the dial
  to work).
