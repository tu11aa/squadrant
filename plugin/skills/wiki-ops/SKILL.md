---
name: wiki-ops
description: Compile discovered knowledge into persistent, cross-referenced wiki pages in spoke vaults. Use after learning something notable, at task completion, and during session shutdown.
---

# Wiki Operations

## Overview

The wiki is your project's compiled knowledge base. Unlike learnings (individual observations, possibly ephemeral), wiki pages are **persistent, cross-referenced, and indexed**.

- **Learnings** = raw observations ("I found that X causes Y")
- **Wiki pages** = compiled knowledge ("How X works", "Architecture of Y", "Patterns for Z")

## When to Ingest

1. **After task completion** — if you discovered how a system works, document it
2. **After resolving a tricky bug** — document the root cause and fix pattern
3. **When a learning is marked useful 2+ times** — promote it to a wiki page
4. **During session shutdown** — review what you learned, compile if notable
5. **When you notice a gap** — if you searched the wiki and didn't find what you needed, create the page after you find the answer

## Creating/Updating a Wiki Page

```bash
~/.config/squadrant/scripts/wiki-ingest.sh "{spokeVaultPath}" "{slug}" "{title}" "{category}" "{body}" "{tags}" "{source}"
```

**Parameters:**
- `slug`: URL-friendly name (e.g., `auth-flow`, `cairo-contract-patterns`)
- `title`: Human-readable title
- `category`: One of: `Architecture`, `Patterns`, `APIs`, `Configuration`, `Debugging`, `Conventions`, `Dependencies`, `Deployment`
- `body`: Full markdown content (can be multi-paragraph)
- `tags`: Comma-separated keywords
- `source`: How this knowledge was discovered (e.g., "crew debugging issue #42")

**Example:**
```bash
~/.config/squadrant/scripts/wiki-ingest.sh "/path/to/spoke" "starknet-account-deploy" "StarkNet Account Deployment" "Patterns" "Account deployment on StarkNet requires a two-step process:

1. Compute the address from the class hash and constructor args
2. Fund the computed address with ETH
3. Call deploy_account

Common pitfall: the salt must match between compute and deploy." "starknet,deployment,account" "crew debugging deploy failures"
```

## Querying the Wiki

Before starting a new task, check if the wiki has relevant knowledge:

```bash
~/.config/squadrant/scripts/wiki-query.sh "{spokeVaultPath}" "{keyword}"
```

For a quick overview:
```bash
~/.config/squadrant/scripts/wiki-query.sh "{spokeVaultPath}" "{keyword}" --titles-only
```

To browse the full index:
```bash
cat "{spokeVaultPath}/wiki/index.md"
```

## Viewing Recent Changes

```bash
~/.config/squadrant/scripts/wiki-log.sh "{spokeVaultPath}" 10
```

## Promoting Learnings to Wiki

When reviewing learnings and you find one that's been useful multiple times:

1. Read the learning file
2. Expand the observation into a full wiki page with context, examples, and related links
3. Ingest via wiki-ingest.sh
4. The original learning remains (it's the "source" reference)

## Cross-Referencing

When writing wiki page body content, reference related pages using `[[slug]]` syntax:
```
See also [[auth-flow]] for the authentication architecture.
```

After ingesting, check if existing pages should reference the new one.

## Quality Guidelines

- **Be specific**: "StarkNet account deployment requires 3 steps" > "Deployment is complex"
- **Include examples**: Code snippets, command sequences, config fragments
- **Note caveats**: Version-specific behavior, known limitations
- **Cite sources**: Which task/issue/exploration revealed this knowledge
- **Keep pages focused**: One concept per page, link to related pages
