# Spike: does opencode have a usable cross-day session resume?

**Status:** answered — **YES**
**Date:** 2026-07-29
**Blocks:** #628 (driver-agnostic captain lifecycle) → #627 (manual mode)
**Context:** [`2026-07-29-provider-independence-two-phase-plan.md`](2026-07-29-provider-independence-two-phase-plan.md) §2.1
**Method:** live execution against opencode **1.18.9**, throwaway git repos under `/tmp/oc-spike/`,
model `google/gemini-2.5-flash`. **No Anthropic credentials involved in any test** —
`auth.json` holds `deepseek, zhipuai, zai, google, zenmux` only. No real project was touched.

## Answer

**YES.** opencode has a direct `claude -c` equivalent, and it is *better* specified than
Claude Code's: resume is a pure function of on-disk SQLite rows keyed by working directory,
with a deterministic by-id variant. Cross-day resume is **not** a blocker for #628.

| Question | Answer |
|---|---|
| `claude -c` equivalent? | **Yes** — `-c` / `--continue` on both `opencode run` (headless) and `opencode` (TUI) |
| Deterministic variant? | **Yes** — `-s <sessionID>` / `--session`, plus `--fork` to branch without mutating |
| Keyed by what? | **Working directory** (realpath), newest **root** session in that directory |
| Survives shutdown / new day? | **Yes** — pure on-disk state, no daemon, no TTL, no pruning |
| Readable by other processes? | **Yes** — plain SQLite (WAL), concurrent-readable, plus 3 CLI surfaces |

## Evidence

Every row below is a command that was actually run, not a doc reading.

### E1 — `-c` resumes across a fully cold process boundary

```
$ cd /tmp/oc-spike/a && opencode run -m google/gemini-2.5-flash \
    "Remember this token exactly: XYZZY-7734-ALPHA. Reply with only the word OK."
OK
$ ps aux | grep -c "[o]pencode"          # ← zero live processes between turns
0
$ cd /tmp/oc-spike/a && opencode run -c -m google/gemini-2.5-flash \
    "What was the exact token I asked you to remember? Reply with only the token."
XYZZY-7734-ALPHA
```

No process, no socket, no daemon held the state. It came off disk.

### E2 — scoping is per-directory, not "globally last"

Two separate git repos. `d` was seeded **after** `c`, so `d` holds the globally-newest session.

```
c: CHARLIE-4242-BRAVO   (seeded first)
d: DELTA-9999-ECHO      (seeded second → globally newest)

$ cd /tmp/oc-spike/c && opencode run -c … "What exact token …?"
CHARLIE-4242-BRAVO      # ← not DELTA; directory wins over recency
```

Same result in the **interactive TUI** (driven over a pty): it opened
`/private/tmp/oc-spike/c` and answered `CHARLIE-4242-BRAVO`, never leaking `DELTA`.
This matters because the captain runs the TUI, not `run`.

### E3 — subagent (child) sessions are correctly excluded

A child session is created ~4s *after* its parent, so a naive "newest session in this
directory" would resume the subagent's context. It does not:

```
ses_05264c749…              (root)   spikeC-turn1          18:20:58
ses_05260ddfd…              (root)   spikeC-subagent       18:25:15
ses_05260cd88…  parent=…ddfd (child) Reply with PING       18:25:19  ← newest
$ opencode run -c … "summarize what has been discussed"
"I was asked to use the `task` tool to spawn a subagent … which replied PONG."
```

It resumed the newest **root**, skipping the newer child. 89 of 370 sessions in the live
DB are children, and 7 directories currently have a child as their newest session — so this
was a real hazard, and opencode handles it.

### E4 — durability: no TTL, no pruning, no archival

```sql
select count(*), min(time_created), max(time_created) from session;
→ 370 sessions, 2026-01-26 → 2026-07-29   (6 months)
select count(*) from session where time_archived is not null;  → 0
select count(*) from session where time_compacting is not null; → 0
```

The oldest session still has its messages intact. There is no recency term anywhere in the
resolution — a day boundary or a reboot is not a variable the mechanism can observe.

> **Caveat, stated honestly:** a literal 24-hour wait was not performed. The claim rests on
> E1 (resume with zero live processes ⇒ state is a file) plus E4 (no expiry mechanism
> exists). One residual is real and is recorded as **T3** below.

### E5 — storage format and third-party readability

`~/.local/share/opencode/opencode.db` — SQLite, `journal_mode=wal`, **7.7 GB** on this machine.

```
tables: session, message, part, project, project_directory, session_message,
        session_input, permission, todo, workspace, event, …
```

`session` carries `id, project_id, parent_id, directory, title, agent, model,
time_created, time_updated, time_archived, cost, tokens_*`.

Three read surfaces, all usable from another process:

| Surface | Verified |
|---|---|
| `sqlite3 -readonly …/opencode.db "<sql>"` | works **while opencode is running** (WAL) |
| `opencode db "<sql>" --format json` | works; `opencode db path` prints the location |
| `opencode export <id>` → `{info, messages}` JSON | works; 15 KB for an 8-message session |
| `opencode session list` | directory-scoped, hides child sessions |

This is the direct analogue of Claude Code's `~/.claude/projects/*.jsonl`, and is *easier*
to consume — indexed SQL instead of a 5.7 MB JSONL scan. It is the natural source for the
**warm-takeover digest** in Phase 1.4.

### E6 — project identity is the repo's root commit hash

```
/tmp/oc-spike/c  first commit affbd90…  → project_id affbd90ca09d8c844fc5a962386677b4e7a902a1
/tmp/oc-spike/d  first commit d1a7b60…  → project_id d1a7b60bfa865751a4d810744a32a02411848e99
```

Consequence for squadrant: **all worktrees of a repo share one `project_id`, but sessions
resume per `directory`.** Each crew worktree therefore keeps its own independent session —
which is the behaviour we want, and it already works.

## Traps

Four, three of them newly found. These are the parts worth carrying into #628.

### T1 — a non-repo directory falls into the shared `global` project

A directory that is not a git repo *with at least one commit* is assigned `project_id =
'global'`, which is shared by every such directory on the machine. Observed directly: with
two commit-less dirs, launching the TUI with `-c` in dir `a` **opened dir `b`'s session and
changed the working directory to `b`**. Recreating both dirs with an initial commit made
the behaviour correct.

*Mitigation:* refuse to boot a captain with `-c` in a directory that is not a git repo with
≥1 commit. Cheap to check, and it prevents a captain silently adopting another project's
conversation.

### T2 — `-s <sessionID>` only works from the session's own directory

| Invocation | Result |
|---|---|
| `-s <own-dir session>` from that directory | ✅ recalled `DELTA-9999-ECHO` |
| `-s <session whose directory was deleted>` | ❌ `UnknownError: Unexpected server error` |
| `-s <session of another project, directory exists>` | ❌ **hangs indefinitely** (killed at 260s) |

The hang is the dangerous one — no error, no timeout. Squadrant must always `cd` into the
session's recorded `directory` before resuming, and should treat a missing directory as
"cold start", not "resume".

### T3 — legacy pre-SQLite sessions do not resume

The 2026-01-26 session (the file-storage era, still present as JSON under
`~/.local/share/opencode/storage/`) fails with `UnknownError` on resume. Migrated rows are
listed but not fully usable. Only affects sessions older than the SQLite migration; harmless
today, but it means "the row exists" is not proof "it resumes" — the one honest gap in E4.

### T4 — the Anthropic default (already known, still live in code)

`ensureGlobalOpencodeConfig` (`packages/cli/src/lib/per-crew-settings.ts`) writes
`model: "anthropic/claude-sonnet-4-5"`. This machine's `~/.config/opencode/opencode.json`
currently reads `google/gemini-3.1-pro-preview`, so it happens to be safe — but the code
default still points an opencode captain at Anthropic, i.e. it dies in exactly the outage it
exists to survive. Confirmed still relevant; fix belongs to Phase 1.4 as already planned.

## What this means for #628

§2.1 lists four lifecycle gaps. This spike closes the one marked *"unverified; needs a spike"*:

- interactive boot for the captain role — reuse crew recipe (unchanged)
- readiness gate per agent — reuse `splashMarker: "Ask anything"` (unchanged)
- turn-end detection per agent — SSE `/event` (unchanged, still needs its own repro)
- **cross-day resume — RESOLVED: `-c` per directory, or `-s <id>`, no new mechanism needed**

Recommended shape, in order of preference:

1. **Record the session id at spawn and resume with `-s <id>` from the project directory.**
   Deterministic. Immune to the user having run `opencode` manually in the same directory
   between captain sessions — which `-c` is not, since `-c` blindly takes the newest root.
   The id is available immediately after boot via
   `sqlite3 -readonly $(opencode db path) "select id from session where directory=… and parent_id is null order by time_created desc limit 1"`.
2. **Fall back to `-c`** when no id was recorded.
3. **Fall back to cold start + boot brief** when the directory has no session at all.

This composes with Phase 1.4's boot brief rather than competing with it: resume restores the
conversation, the brief restores the *world* (handoff, live crews, open PRs). For a captain
that has been dead for days, warm resume of a stale conversation may well be worse than a
cold start with a fresh brief — that is a **product** decision, no longer a technical unknown.

## Follow-ups worth filing separately

- **`opencode.db` is 7.7 GB.** Anything squadrant builds on top of it should query with
  indexed SQL and never table-scan. Also a plain disk-hygiene concern independent of this work.
- **Digest source is now symmetric.** Claude Code (JSONL) and opencode (SQLite) can both feed
  the Phase 1.4 warm-takeover digest through one interface. Worth designing once.

## Reproduction

```bash
mkdir -p /tmp/oc-spike/c && cd /tmp/oc-spike/c && git init -q \
  && echo x > README.md && git add . && git commit -qm init      # T1: the commit matters
opencode run -m google/gemini-2.5-flash "Remember token FOO-123. Reply OK."
ps aux | grep -c "[o]pencode"                                     # expect 0
opencode run -c -m google/gemini-2.5-flash "What token? Reply with only the token."
```
