# Human review: <topic>, <YYYY-MM-DD>

LOCAL ONLY. Never post this guide, or any part of it, on a PR, issue, tracker or chat.

Anchors verified with `git grep -n <pattern> origin/<branch>` at these heads (refresh on every head update):

| PR | Head SHA |
|---|---|
| #A | `<sha>` |

---

## 0. Read first (several PRs only)

### 0.1 Summary

| # | PR | Branch → base | Size | Est. time | Focus | Gates |
|---|---|---|---|---|---|---|
| 1 | #A <title> | `feat/a` → `develop` | 12 files, +340/−20 | 30 min | High | CI green, agent review approved |

### 0.2 Stack

```
develop ← #A ← #B ← #C
```

### 0.3 Gates already run: coverage map (do not redo)

| Gate | What it covers in this diff | Bug class it catches |
|---|---|---|
| Agent review (several rounds) | <files/areas, findings fixed> | Logic bugs, edge cases |
| CI vs base | <result> | Build, types, tests |

The guide holds only what no gate covered, or only a human can judge.

### 0.3b Gate gaps (should be machine-checked, no gate covers)

| Gap | Where it shows | Suggested new gate or follow-up ticket |
|---|---|---|
| <e.g. a template no test renders> | <PR / file> | <e.g. add a render test; ticket #N> |

### 0.4 What the human gate is for

1. **Intent and scope** — does the PR do what was asked, and nothing more?
2. **Public contracts** — names of fields, routes, error codes, keys. Costly to change after merge.
3. **Architecture trade-offs** — A chosen over B; is the reason convincing; does it create debt?
4. **Test validity** — run the manual mutation; does the test go red?
5. **Live comparison** — UI next to the design or prototype.

### 0.5 Severity prefixes

| Prefix | Meaning | Author does |
|---|---|---|
| *(none)* | Required before merge | Fix |
| `Critical:` | Blocks merge | Fix now |
| `Consider:` | Worth weighing | Fix or explain |
| `Nit:` | Optional | May ignore |
| `FYI` | Information | Nothing |

### 0.6 Open the code

```bash
git fetch origin
git worktree add ../review-a origin/feat/a   # read-only
gh pr diff <N>                               # one PR's diff
```

### 0.7 Review order, merge order, collapse

- **Review order:** #A, then #B. Why: <contract/backend first, then UI; stack order within a stack>.
- **Merge order:** #A, then #B (bottom of the stack first).
- **Collapse into fewer PRs for the lead?** <recommendation and reason; one PR per ticket is often clearer>.

---

## PR #A — <title> (`feat/a` → `develop`, head `<sha>`)

### 1. Context
Ticket: <id>. Size, base/stack position, gates run and findings.
- **Features added:** <list, optional>
- **Bugs fixed:** <list, optional>
- **Deliberately not done:** <list, optional>
- **Breaking changes:** <list, optional>
- **Waits on:** <other people or PRs, optional>

### 2. Tests first
- `src/orders/orders.service.test.ts` proves <behaviour>.
  - **Mutation:** change `<expr>` at `src/orders/service.ts:88` (`createOrder`); `<case>` must go red.
- `<another test path>` proves <behaviour>. (one mutation per test where one makes sense)

### 2b. Compare with the design (UI PRs only)
- **Open:** <what to open>
- **Compare:** <layout, labels, empty and error states>

### 3. Implementation points

#### 3.1 <short title>
- **Where:** `src/orders/service.ts:88` — `createOrder`
- **Gated by:** none | <gate> (partial: <what it covers>)
- **What:** <what the code does>
- **Why:** <the problem or need the reviewer sees: symptom, requirement, constraint>
- **Cause:** <root cause: what in the code, data or design produced it; required for a bug fix, review finding or reversed choice, omit for a pure design choice>
- **Solution:** <approach and trade-off>
- [ ] **You judge:** <the concrete question only a human can answer>
- **Axis (tags):** one or more of Correctness | Readability | Architecture | Security | Performance

### 4. Verdict
Short line: **Approve** | **Request changes** (the HTML's selector, notes and Copy my findings produce it).

---

## Pending decisions (optional; refresh or clear on every head update)
- <decision waiting on someone>

## Before handing to the lead (optional; concrete items for these PRs only)
- [ ] <e.g. follow-up ticket filed for point 2>
