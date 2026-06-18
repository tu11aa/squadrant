---
name: where-i-am
description: Print a tight "where am I on this project?" orientation report — a "right now" punchline plus Done (and what it means) / In progress / Next / Watch. Use when context-switching into a long-running project, resuming after a compact, or whenever you ask "where was I / what's the status / /wim / /where-i-am".
---

# Where I Am

Answer **"where am I on this project?"** in a short, scannable report instead of a wall of text. Built for switching between long-running projects without losing the thread.

Read-only. This skill **writes nothing** and **consumes nothing** — pure orientation.

## Output shape

Open with a one-line punchline, then the four sections in order:

```markdown
**Right now →** <what you're actively doing / waiting on this moment, and your immediate next move>

## ✅ Done — and what it means
- <completed work> → <why it matters / what it unblocks>

## ⏳ In progress
- <work actively moving> — <state / owner: crew fixing, waiting on CI, mid-refactor>

## ▶️ Next
- ⬜ <the next not-yet-started step(s)>

## ⚠️ Watch
- <blockers, fragile state, gotchas, "don't forget", contradictions between sources>
```

Status markers — use inline when listing the steps of a track: ✅ done · ⏳ in progress · ⬜ not started.

Rules for the report:
- **`Right now →` is the most important line** — the fast-orientation cue. Always include it; one line.
- **Bullets, not paragraphs.** A handful per section, most-relevant first.
- Each **Done** bullet pairs *what happened* with *why it matters* (`→`). A commit without significance is noise.
- **In progress vs Next:** ⏳ is work already moving (a crew is on it, a branch is open, you're mid-edit); ⬜ Next is not yet started. Don't conflate them — the whole point is knowing what's live vs queued.
- **Multi-track projects** (e.g. a feature track + a bugfix track running in parallel): group bullets under bold track labels (`**Reorg track:**`, `**Bug-fix track:**`) inside the sections.
- If a section is genuinely empty, write `- — nothing` rather than padding.
- Synthesize, don't dump. Never paste raw git log / observation lists — distill them.

## Source priority (current → durable)

Lead with the live session; use durable sources to fill gaps and cross-check.

1. **Current session context — primary.** What *this* conversation has done, decided, and left open. Freshest signal, especially mid-task.
2. **claude-mem recent observations** — the narrative across prior sessions (use the `mem-search` skill, or the recent-context already injected at session start).
3. **Handoff + latest daily-log** — explicit `nextSteps` / `blockedItems` / `decisions` and `Tomorrow` / `Blocked`.
4. **git** — ground truth of where the code actually sits.

When the session is thin (e.g. right after a compact / brand-new session), lean harder on 2–4. When sources **disagree** — git shows work the session doesn't mention, or claude-mem says a thing shipped that the branch contradicts — that contradiction is a **⚠️ Watch** item, not noise.

## How to build it

**1. Resolve the current project** (degrade gracefully if not a cockpit project):

```bash
PROJECT_JSON=$(node -e '
  const fs=require("fs"),os=require("os"),path=require("path");
  const cfg=JSON.parse(fs.readFileSync(os.homedir()+"/.config/cockpit/config.json","utf8"));
  const cwd=process.cwd();
  let best=null;
  for (const [name,p] of Object.entries(cfg.projects||{})) {
    if (cwd===p.path || cwd.startsWith(p.path+"/")) {
      if (!best || p.path.length>best.path.length) best={name,...p};
    }
  }
  process.stdout.write(JSON.stringify(best||{}));
' 2>/dev/null)
echo "$PROJECT_JSON"
```

If empty `{}`: not inside a known cockpit project — build the report from **session context + git only**, and skip steps 2–3 below.

Otherwise note `name` and `spokeVault` for the next steps.

**2. Read the handoff WITHOUT consuming it** (note the `--keep` — never drop the `--keep`, or you destroy the next session's startup context):

```bash
~/.config/cockpit/scripts/read-handoff.sh "<spokeVault>" --keep
```

`{"exists": false}` means none — fine, skip it.

**3. Read the latest daily-log** (if any):

```bash
ls -t "<spokeVault>"/daily-logs/*.md 2>/dev/null | head -1
```

Read that one file for `Completed` / `In Progress` / `Blocked` / `Tomorrow`.

**4. Read git ground-truth:**

```bash
git -C "<project path or PWD>" status -sb && echo "---" && git -C "<project path or PWD>" log --oneline -8
```

**5. claude-mem** — if recent observations weren't already injected this session, pull them with the `mem-search` skill scoped to the project name.

**6. Synthesize** all of the above into the `Right now →` line plus the four sections and print. Lead with the session, resolve disagreements into **⚠️ Watch**. Stop there — do not start acting on "Next" unless the user asks.
