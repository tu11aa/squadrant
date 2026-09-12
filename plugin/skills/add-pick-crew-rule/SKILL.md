---
name: add-pick-crew-rule
description: Add, edit, or remove a leveled crew routing rule in config.json without hand-editing JSON. Routing rules map task-text keywords to a tier → {agent, model}.
---

# Manage Crew Routing Rules

Crew routing rules live in `defaults.crewRouting.rules` inside `~/.config/squadrant/config.json`.
Each rule has the shape:

```jsonc
{
  "tier":  "<label>",      // human label, e.g. "extreme" / "hard" / "daily"
  "match": "<regex>",      // case-insensitive regex tested against the task text
  "agent": "claude|codex|gemini|opencode",
  "model": "opus|sonnet|flash|<literal upstream id>",  // a squadrant alias or a literal
  "backend": "native|direct|proxy"   // optional; claude-only for direct/proxy
}
```

Rules are evaluated in order; the **first match wins**.

`backend` is meaningful only for `agent: "claude"`:
- `native` (default) — the CLI's own auth; no router needed.
- `direct` — point Claude at `defaults.router.baseUrl` directly.
- `proxy` — point Claude at the squadrant loopback shim.

A rule with `backend: "direct"` or `"proxy"` **requires `defaults.router`** to be configured;
otherwise the spawn fails with a hard error and `squadrant config check` flags it.

`model` may be either a **squadrant alias** (defined in `defaults.router.models`) or a literal
upstream id. An alias expands per agent — e.g. `flash` →
`deepseek-v4.1-flash` for claude, `opencode-go/deepseek-v4.1-flash` for opencode. A value that is
not a defined alias is used verbatim, so existing configs keep working.

## Adding a rule

1. Read the current config:
   ```bash
   cat ~/.config/squadrant/config.json
   ```

2. Identify the `defaults.crewRouting.rules` array. If it is absent, add it.

3. Build the new rule object. Validate:
   - `tier` is a non-empty string
   - `match` is a valid regex (test it mentally against a sample task string)
   - `agent` is one of `claude`, `codex`, `gemini`, `opencode`
   - `model` may be a squadrant alias (see `defaults.router.models`) or a literal upstream id; aliases expand per agent

4. Insert the rule at the correct position — **rules are evaluated in order**.
   Higher-priority / more specific tiers (e.g. "extreme") belong before broader ones
   (e.g. "hard"). Append low-priority catch-alls last.

5. Write the updated config back via the existing save path:
   ```typescript
   // The saveConfig helper in src/config.ts handles atomic write + newline.
   // If editing the live file directly, use JSON.stringify(config, null, 2) + "\n".
   ```

6. Verify the rule fires as expected:
   ```bash
   # Quick smoke-test (no live crew spawned):
   node -e "
     const {loadConfig} = require(process.env.HOME + '/.config/squadrant/node_modules/...');
     // or just log the matching rule manually
     const rules = require(process.env.HOME + '/.config/squadrant/config.json')
       .defaults?.crewRouting?.rules ?? [];
     const task = 'YOUR TEST TASK HERE';
     const hit = rules.find(r => new RegExp(r.match,'i').test(task));
     console.log(hit ?? 'no match');
   "
   ```

## Editing an existing rule

Read → locate the rule by `tier` or `match` → update the field(s) → write back.

## Removing a rule

Read → filter out the rule by `tier` or `match` → write back.

## Precedence reminder

- Explicit `--agent` / `--model` / `--backend` on `squadrant crew spawn` **always** override routing.
- `backend` precedence: `--backend` > rule `backend` > `defaults.roles.<role>.backend` > `native`.
- Passing `--agent` or `--model` suppresses the rule entirely (including its `backend`).
- If no rule matches, the spawn falls through to `defaults.roles.crew` behavior.

## Example rules

```jsonc
// Route deep-reasoning work to the strongest model
{ "tier": "extreme", "match": "redesign|architect|rewrite|from scratch|deep reasoning", "agent": "claude", "model": "opus" }

// Route standard feature/refactor work to a faster model
{ "tier": "hard",    "match": "refactor|migrate|implement|feature|daemon|control-plane", "agent": "claude", "model": "sonnet" }

// Route mobile tasks to codex (no model — uses codex default)
{ "tier": "mobile",  "match": "mobile|ios|swift|android|kotlin|react native", "agent": "codex" }

// Route trivial edits to opencode (cheapest path)
{ "tier": "daily",   "match": "typo|rename|bump|docs|comment|lint|format", "agent": "opencode" }
```
