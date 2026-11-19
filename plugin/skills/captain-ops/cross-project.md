# captain-ops reference: Groups and cross-project work

_Read this before touching a sibling project or sending a ping or dispatch. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


## Group Awareness

If your config has `group` / `groupRole`:
- Read full config to find sibling projects with the same `group`
- If your change might affect a sibling, **flag it to command** so it can notify the sibling's captain
- Use **claude-mem** to search for context from sibling projects
- `primary` role: your changes may need propagation to forks/dependents

## Cross-Project Delegation

Two commands reach **any registered project** — not just siblings in your group. Group membership is extra guarantees on top, not a requirement to reach a project at all.

- **`squadrant ping <project> "<msg>"`** — fire-and-forget. Delivers a message straight into the target's captain pane. No tracked task, no report-back. Use for a heads-up, FYI, or a question you don't need answered structurally.
- **`squadrant dispatch <project> "<task>"`** — tracked. Records a task on the target project, notifies its captain, and reports the outcome back to your mailbox when it settles. (`squadrant group dispatch` is a **deprecated alias** for this — same underlying machinery, keep using `squadrant dispatch` going forward.)

### Rules

1. **Unregistered project → clear error.** Both commands validate the project exists in config before doing anything.
2. **`acceptDelegations`.** If the target's project config has `acceptDelegations: false`, `dispatch` rejects with a clear error — this applies regardless of group. The default is `true`.
3. **Boot-if-down is a same-group guarantee.** If the target is in your group and its captain isn't running, `dispatch` boots it (`squadrant launch <project>`) and waits for warmup with a bounded poll (120s hard timeout). **Cross-group, dispatch does NOT auto-boot** a down captain — it fails fast with an error suggesting `ping` or starting it manually with `squadrant launch <project>`, then retry. Once a target captain is up, cross-group and same-group dispatch behave the same.

### Dispatch-and-yield (do NOT poll)

Once the task is recorded to the daemon, `dispatch` **returns immediately**. The target's captain auto-accepts (because `acceptDelegations` is true) and spawns a crew. When the task settles — done, blocked, or failed — the daemon fans the outcome back to **your** mailbox automatically. The daemon wakes you up. **You never poll the target.**

HARD RULE: Do NOT add a polling loop after `dispatch`. The report-back is event-driven; trust it.

### Report-back format

| Settlement | Message |
|------------|---------|
| done | `✅ Cross-project task → B: done — <task snippet>` |
| blocked | `⛔ Cross-project task → B: blocked — <question>` |
| failed | `⛔ Cross-project task → B: failed — <error>` |
| stalled | `⚠️ Cross-project task → B: stalled (no heartbeat)` |

### Example

```bash
# You are captain of "scaffold-stylus". Ask the docs sibling to update docs.
squadrant group dispatch scaffold-stylus-docs "Document the new --format flag added in PR #42"
# → "✔ Dispatched to 'scaffold-stylus-docs' (task abc12345)"
# → (returns immediately; you are notified when settled)
```
