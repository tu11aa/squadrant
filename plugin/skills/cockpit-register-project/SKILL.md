---
name: cockpit-register-project
description: Register an existing local repo (or GitHub URL) into cockpit config. Use when a project already exists and just needs to be wired into cockpit.
---

# Register an Existing Project

Use when the repo already exists locally or on GitHub and you just need to register it in cockpit.

## Step 1 — Resolve the local path

**Local path given:** use it directly.

**GitHub URL given:** clone first, then use the destination:
```bash
gh repo clone <org>/<repo> <dest-path>
```

## Step 2 — Determine the project name

Default to the directory name:
```bash
basename <path>
```

Override if the directory name is ambiguous (e.g. `src`, `app`).

## Step 3 — Determine group placement

List existing projects and their groups:
```bash
cockpit projects list
```

Then decide:

**New group** — pick a group name (kebab-case). This project will be `primary` automatically (first in group). No `--group-role` needed.

**Existing group** — pick the group name and specify a role that describes this project's purpose (e.g. `"documentation site"`, `"agent task queue"`, `"shared skills library"`). The role must NOT be `"primary"` — that slot is already taken by the first project in the group.

> Note: `--group-role` only auto-sets to `"primary"` when it is the first project registered in a group. All subsequent projects in the same group require an explicit `--group-role`.

## Step 4 — Register

```bash
cockpit projects add <name> <path> \
  --captain "⚓ <name>-captain" \
  [--group <group-name>] \
  [--group-role "<role description>"]
```

Omit `--group` and `--group-role` entirely if this is a standalone project with no group.

## Step 5 — Verify

```bash
cockpit projects list
```

Confirm the new entry appears with the correct path, group, and role.
