---
name: set-effort
description: Read or set the global crew tokenomics dial (max | balance | low). Use when the user wants to change how aggressively crews consume tokens, or to check the current setting.
---

# cockpit:set-effort — Global Crew Effort Dial

The effort dial is a one-field toggle in `~/.config/cockpit/config.json` that biases the captain's crew spawning decisions. It does **not** rewrite routing rules — it is a hint the captain honors when choosing agent/model for new crews.

## Modes

| Mode | Meaning |
|------|---------|
| **max** | Tokens are plentiful. Prefer claude/opus for crew spawns; don't downshift for cost. |
| **balance** | Normal. Use default crew routing rules unchanged. (Default when field is absent.) |
| **low** | Conserve tokens. Prefer opencode/sonnet for crews; reserve opus for work that genuinely needs it. |

## Get current effort

```bash
cockpit effort
```

Prints the current mode and its one-line meaning. Does not write anything.

## Set effort

```bash
cockpit effort max
cockpit effort balance
cockpit effort low
```

- Validates the value (errors with the 3 valid options if invalid).
- Writes `defaults.effort` via the existing `saveConfig` atomic path.
- Prints a confirmation line.
- Best-effort: sends a one-line notice to any running captain workspace so a live session adjusts immediately. If no captain is running, the change applies on next launch.

## Manual edit (fallback)

If the CLI is unavailable, edit `~/.config/cockpit/config.json` directly:

```json
{
  "defaults": {
    "effort": "low"
  }
}
```

Valid values: `"max"` | `"balance"` | `"low"`. Absent field is equivalent to `"balance"`.

## Scope

Effort is **crew-only**. It does not affect captain, command, or side roles — those stay pinned to their configured model regardless of effort.

## Precedence

Effort is the weakest signal. Explicit `--agent` / `--model` flags on `cockpit crew spawn` always win. Effort only biases the captain's default choice when nothing more specific applies.
