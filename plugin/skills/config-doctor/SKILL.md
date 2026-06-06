---
name: config-doctor
description: Reconcile cockpit config drift that needs human judgment — changed defaults and invalid values surfaced by `cockpit config check`. Use when the drift banner says "items need review" or the user asks to fix config drift.
---

# Config Doctor

Reconcile the config-drift items that `cockpit config check --fix` deliberately does NOT auto-apply: `changed-default` (you may have customized on purpose) and `invalid` (a value that no longer resolves). The safe tier (missing/deprecated) is already handled by `--fix`; do not duplicate it.

## Steps

1. **Get structured drift:**
   ```bash
   cockpit config check --json
   ```
   This prints a `DriftItem[]`. Focus only on items with `kind` of `changed-default` or `invalid`.

2. **Apply the safe tier first (if any missing/deprecated remain):**
   ```bash
   cockpit config check --fix
   ```
   Re-run `--json` afterward to see what judgment items remain.

3. **For each `changed-default` item:**
   - Show the user: `path`, their `current` value, the new `suggested` default, and the `note`.
   - Ask: *adopt the new default, or keep your value?*
   - If keep → no edit needed (it will be dismissed in step 5 via `--accept`).
   - If adopt → edit `~/.config/cockpit/config.json`, setting `path` to `suggested`. Edit ONLY that path.

4. **For each `invalid` item:**
   - Explain why it's invalid (the `note` says, e.g. "unknown driver 'aider'").
   - Propose the correct value (e.g. switch driver to `claude`/`codex`/`opencode`, or remove the dead agent).
   - On confirmation, edit `~/.config/cockpit/config.json` for that path only. Never touch `projects`, `hubVault`, `commandName`, or other user-data sections.

5. **Finalize:**
   ```bash
   cockpit config check          # confirm zero remaining drift
   cockpit config check --accept # stamp the version so the banner goes quiet
   ```
   If `check` still shows items the user intentionally kept, `--accept` is the correct way to dismiss them.

## Rules

- Edit only the exact dotted paths flagged. One concern per edit.
- Never auto-decide a `changed-default` — it is the user's call.
- After reconciling, the stamp must equal the running cockpit version or the banner returns.
