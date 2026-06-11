---
name: cockpit-new-project
description: Create a brand-new GitHub repo, clone it, and register it in cockpit. Handles both new workspace (new group) and existing workspace (join existing group).
---

# Create and Register a New Project

Use when the project does not exist yet — you need to create the GitHub repo, clone it locally, and wire it into cockpit.

## Step 1 — Collect inputs

You need:
- **Repo name** (kebab-case, e.g. `my-project`)
- **GitHub org or user** (e.g. `Quantum3-Labs` or your GitHub username)
- **Visibility** — `public` or `private`
- **Local parent directory** — where to clone into (e.g. `/Users/you/Q3/MyGroup/`)

## Step 2 — Determine workspace placement

**New workspace** (no existing group):
- Pick a group name (kebab-case). This project will be `primary` automatically.
- No `--group-role` needed.

**Existing workspace** (joining an existing group):
- Run `cockpit projects list` to see current groups.
- Pick the group to join and specify a role for this project (e.g. `"landing page"`, `"mobile client"`, `"CLI tool"`).
- The role must NOT be `"primary"` — that slot is already taken.

## Step 3 — Create the GitHub repo and clone

```bash
gh repo create <org>/<repo-name> --[public|private] --clone --clone-dir <parent-dir>
```

This creates the repo on GitHub and clones it into `<parent-dir>/<repo-name>`.

## Step 4 — Optional: initial scaffold

If the repo should start with a README and first commit:
```bash
cd <parent-dir>/<repo-name>
echo "# <repo-name>" > README.md
git add README.md
git commit -m "chore: initial commit"
git push
```

Skip if the repo already has content or the user wants to scaffold separately.

## Step 5 — Register in cockpit

```bash
cockpit projects add <repo-name> <parent-dir>/<repo-name> \
  --captain "⚓ <repo-name>-captain" \
  [--group <group-name>] \
  [--group-role "<role description>"]
```

Omit `--group` and `--group-role` for a standalone project with no group.

## Step 6 — Verify

```bash
cockpit projects list
```

Confirm the new entry appears with the correct path, group, and role.
