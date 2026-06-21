---
name: karpathy-principles
description: Four coding principles derived from Andrej Karpathy's observations on LLM pitfalls. Use to reduce wrong assumptions, overengineering, drive-by refactors, and vague execution. Apply to every crew coding task and every captain review.
---

# Karpathy Coding Principles

Derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on how LLMs fail at coding. Ported from [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) (MIT).

These four principles apply to every coding task — whether you are a captain reviewing a crew's work or a crew member writing code.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly — if uncertain, ask rather than guess
- Present multiple interpretations when ambiguity exists — don't pick silently
- Push back when warranted — if a simpler approach exists, say so
- Stop when confused — name what's unclear and ask

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked
- No abstractions for single-use code
- No "flexibility" or "configurability" that wasn't requested
- No error handling for impossible scenarios
- If 200 lines could be 50, rewrite

**Test:** Would a senior engineer call this overcomplicated? If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't improve adjacent code, comments, or formatting
- Don't refactor things that aren't broken
- Match existing style, even if you'd do it differently
- If you notice unrelated dead code, **mention** it — don't delete it

When your changes create orphans:
- Remove imports/variables/functions that **your changes** made unused
- Don't remove pre-existing dead code unless asked

**Test:** Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform imperative tasks into verifiable goals:

| Instead of... | Transform to... |
|---|---|
| "Add validation" | "Write tests for invalid inputs, then make them pass" |
| "Fix the bug" | "Write a test that reproduces it, then make it pass" |
| "Refactor X" | "Ensure tests pass before and after" |

For multi-step tasks, state a brief plan with per-step verification:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria let the agent loop independently. Weak criteria ("make it work") force constant clarification.

## Tradeoff

These principles bias toward **caution over speed**. For trivial tasks (typo fixes, obvious one-liners) use judgment — not every change needs the full rigor. The goal is reducing costly mistakes on non-trivial work, not slowing down simple tasks.

## Squadrant-specific notes

- Squadrant already uses TDD via the `superpowers:test-driven-development` skill — principle 4 complements it, does not replace it
- Captains applying these principles during review: if a crew member violates principle 3 (drive-by refactors), request they split the commit
- Crew should report blockers in status.md when principle 1 triggers ("unclear" / "multiple interpretations")

## Attribution

- Original principles: [Andrej Karpathy on X](https://x.com/karpathy/status/2015883857489522876)
- Packaging: [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) (MIT)
