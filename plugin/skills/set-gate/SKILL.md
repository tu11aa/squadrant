---
name: set-gate
description: Read or set the permission gate mode (on | off | auto). Use when the user wants to flip the gate on to test an unattended crew, off when the classifier misbehaves, or to check the current mode.
---

# squadrant:set-gate — Permission Gate Mode

`defaults.gate.mode` (#782/#828) controls whether squadrant's own classifier decides a router-backed crew/captain's `PermissionRequest`, instead of Claude Code's built-in auto-mode classifier (which is hardcoded to Claude Sonnet 5 and fails closed on a router backend).

## Modes

| Mode | Meaning |
|------|---------|
| **on** | squadrant's gate decides — the configured `engine` (`router` or `auto-gate`) classifies each request. |
| **off** | The gate never touches a `PermissionRequest` — the agent's normal permission flow is untouched. |
| **auto** | Yield to the agent's own built-in classifier. Default when the field is absent — zero behavior change. |

## Get current mode

```bash
squadrant gate mode
```

Prints the effective mode and where it came from: `env` (the `SQUADRANT_GATE` override), `config` (`defaults.gate.mode`), or `default` (`auto`, field absent).

## Set mode

```bash
squadrant gate mode on
squadrant gate mode off
squadrant gate mode auto
```

- Validates the value (errors with the 3 valid options if invalid).
- Writes `defaults.gate.mode` via the existing `saveConfig` atomic path.
- Prints `old → new`.
- No daemon bounce needed — `defaults.gate.mode` is not daemon-cached; the CLI reads it live on every hook invocation.
- If `SQUADRANT_GATE` is set in the current shell session, it still overrides the config value for that session — the command warns when this is the case.

## Status (classifier + credential, nice-to-have)

```bash
squadrant gate status
```

Prints the effective mode + source, the resolved `engine`, the resolved classifier `model`, and whether the engine's credential resolves (`present`/`absent`). **Never** prints the credential value itself.

## Manual edit (fallback)

If the CLI is unavailable, edit `~/.config/squadrant/config.json` directly:

```json
{
  "defaults": {
    "gate": {
      "mode": "on"
    }
  }
}
```

Valid values: `"on"` | `"off"` | `"auto"`. Absent field is equivalent to `"auto"`.

## Precedence

Env (`SQUADRANT_GATE`) always wins over config, which always wins over the `auto` default. Router-backed crews/captains inject `SQUADRANT_GATE=on` automatically — that session-level override is not undone by changing config.
