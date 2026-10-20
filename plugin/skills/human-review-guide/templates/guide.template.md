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

### 0.3 Gates already run (do not redo)

| Gate | What it did | Bug class it catches |
|---|---|---|
| Agent review (several rounds) | <findings fixed> | Logic bugs, edge cases |
| CI vs base | <result> | Build, types, tests |

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
What it does. What it deliberately does not do. Breaking changes. Size. Base/stack position. Gates run and findings.

### 2. Tests first
- `<test file> › <case>` proves <behaviour>.
- **Mutation:** change `<expr>` at `src/orders/service.ts:88` (`createOrder`); `<test>` must go red.

### 3. Implementation points

#### 3.1 <short title>
- **Where:** `src/orders/service.ts:88` — `createOrder`
- **What:** <what the code does>
- **Why:** <problem or constraint that forced it>
- **How solved:** <approach and trade-off>
- **You judge:** <the concrete question only a human can answer>
- **Axis:** Correctness | Readability | Architecture | Security | Performance

### 4. Checklist
- [ ] Correctness — matches intent, edge cases, errors handled, tests cover behaviour
- [ ] Readability — names, plain code, comments explain why
- [ ] Architecture — fits patterns and layering, no premature abstraction
- [ ] Security — input validated, auth checked, no secrets in logs
- [ ] Performance — no N+1, unbounded loops or hot-path waste
- [ ] UI only: compared with the design live

### 5. Verdict
- Context:
- Correctness:
- Readability:
- Architecture:
- Security:
- Performance:
- Verification:
- **Verdict:** Approve | Request changes

---

## Before handing to the lead
- [ ] Every required and `Critical:` finding resolved
- [ ] Verdicts filled for each PR
- [ ] Anchors and SHAs re-verified at current heads
- [ ] A follow-up ticket exists for each piece of accepted debt
