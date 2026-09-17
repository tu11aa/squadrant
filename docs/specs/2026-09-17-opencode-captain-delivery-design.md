# Opencode captain delivery — native HTTP channel (#786)

**Status:** design, approved direction (not yet implemented)
**Date:** 2026-09-17
**Issue:** [#786](https://github.com/tu11aa/squadrant/issues/786) — captain delivery to an opencode
captain pane fails (no peer socket → claude-tuned box detection → no-box)
**Related:** [#667](https://github.com/tu11aa/squadrant/issues/667) (captain/control channel),
[#628](https://github.com/tu11aa/squadrant/issues/628) (driver-agnostic captain lifecycle),
[#332](https://github.com/tu11aa/squadrant/issues/332) (daemon-direct cmux delivery)

**Scope note:** this spec covers **captain-bound delivery for opencode captains**, end to end:
interactive captain boot with a known port, a persisted captain address (port + session id), an
agent-aware captain channel, and an explicit "captain not deliverable" verdict. It does **not**
redesign the claude path, does not add captain turn-end/SSE liveness, and does not touch pane
scraping. A latent misroute on the **crew** path is called out as a separate follow-up (§9).

## 1. Problem

With an **opencode** captain, captain-bound delivery never reaches the pane. Crew lifecycle events
(`task.done`, `task.turn.completed`) are produced but deferred forever:

```
captain-channel squadrant: session gone — falling back to pane
claude-peer: write failed (gone): connect ENOENT /tmp/cc-socks/squadrant-captain-squadrant.sock
delivery seq=577 kind=task.turn.completed outcome=deferred project=squadrant reason=no-box
delivery stuck project=squadrant deferCount=300 reason=no-box
```

Two independent causes, both verified in-tree:

1. **No native channel is selected for a non-claude captain.** The daemon builds a
   `ClaudePeerChannel` whenever `captainChannel !== "off"`, regardless of the captain's agent
   (`packages/cli/src/squadrantd.ts:297-314` → `packages/cli/src/lib/captain-channel-factory.ts:132`).
   With an opencode captain there is no `/tmp/cc-socks/squadrant-captain-<project>.sock`, so the
   channel returns `gone` (`packages/core/src/captain-channel.ts:52`) and delivery falls back to the
   pane.
2. **The pane scraper is Claude-Code-tuned.** `parseDraftFromScreen`
   (`packages/workspaces/src/runtimes/cmux.ts:164`) recognises `>` / `❯` and the `│ ❯ text │` box;
   opencode's TUI draws a different box, so the detector returns `null` → `DeferReason "no-box"`
   (`packages/core/src/delivery/defer-delivery.ts:9`) forever.

Additionally, the captain launcher never made an opencode captain **addressable**: `buildAgentCmd`
only wires the claude socket path, and for non-claude agents it delegates without `interactive`
or `port` (`packages/agents/src/drivers/launch-cmd.ts:100-111`), and
`shouldWireCaptainChannel` is hard-gated on `agentName === "claude"`
(`packages/cli/src/commands/launch.ts:41-46`).

## 2. Verified evidence (live, 2026-09-17, opencode 1.18.31)

All runs were in throwaway git repos under the OS temp dir. Scripts, raw outputs and screen
captures are preserved at `/var/folders/rv/y35yc8ns24g7js2zg0mtzs3r0000gn/T/opencode/oc786/`
(`verify*.sh`, `result*.txt`, `screen-captain.txt`, `screen-crew.txt`). No project was touched; no
test process was left running.

| # | Test | Result |
|---|---|---|
| 1 | `opencode --port N` / `opencode -s <id> --port N` (TUI under a pty) | **LISTEN 127.0.0.1:N within 2–3s** |
| 2 | `GET /session` | 200; sessions carry `id`, `directory`, `time.updated` |
| 3 | `POST /session/{id}/prompt_async` | **204**; a wrong id → **404** |
| 4 | Does a resumed TUI session run the turn? (warm `-s`) | prompt `WARM-7777-DELTA` → **assistant replied in 4s**; transcript `[user] …` → `[assistant] WARM-7777-DELTA` |
| 5 | Is the HTTP-delivered message **visible on the TUI**? (warm) | **yes** — token rendered in the TUI capture |
| 6 | Negative control: plain `opencode -c` (no `--port`) | **0 TCP listeners** — nothing to adopt |
| 7 | Root cause reproduced locally: real opencode captain/crew panes (`cmux read-screen`) fed to the built parser | `parseDraftFromScreen` → **`null`**; `hasCCInputBox` → **false**; `classifyStartupSurface` → **`"loading"`** (1 and 0 HR lines respectively; the box is drawn with `┃`) |
| 8 | Cold start: fresh repo + `opencode --port N`, nothing typed | `GET /session` = **0 sessions for 40s** — no session exists until a turn is started |
| 9 | **`-c` is NOT directory-scoped inside one repo**: main-dir session `MAINSEED-ALPHA`, worktree session `CREWSEED-BETA` (newer) | TUI rendered `CREWSEED-BETA` (**1**) and `MAINSEED-ALPHA` (**0**) → `-c` resumed the newest session **project-wide** |
| 10 | `directory` path form | opencode returns the **realpath** (`/private/var/…`): raw-path match **0**, realpath match **1** |
| 11 | `POST /session` (create) | **200** with a full session object; visible to `GET /session`; `prompt_async` → 204 and the assistant replied — but the session is **not rendered in the TUI** (**0** occurrences) |
| 12 | `POST /tui/select-session {"sessionID":…}` | **200 `true`** (route exists) — but the message delivered to the created+selected session was still **not rendered** (**0** occurrences) |
| 13 | Cold start via **pane input**: one message typed into a fresh TUI | at t=21s a session appeared in `GET /session` with `directory` == realpath; `prompt_async` into it → assistant replied **and the message is rendered on the TUI** |

Consequences that shaped the design:

- Test 9 kills `-c` for captain resume. Test 4/5 make `-s <persistedId> --port N` the warm path.
- Test 8 + test 13 make the cold path: boot the TUI, deliver the startup prompt through the pane
  (which creates and *displays* the session), then resolve and persist the session id.
- Tests 11/12 rule out an out-of-band-created session: it works technically but the operator cannot
  see it, so it is rejected for a captain pane.
- Test 10 mandates realpath comparison.
- `GET /session` is **project-scoped** (shared by every worktree of the repo), so the resolver must
  filter by exact directory — see tests 9/10 and `OpencodeHttpChannel.resolveSession`
  (`packages/agents/src/opencode/http-channel.ts:111-139`), which currently picks the newest
  project-wide.

Corollary: the same latent misroute applies to `crew send` today (crews resolve by
`rec.serverPort` only, `packages/cli/src/commands/crew.ts:139-141`). Out of scope here — §9.

## 3. Decisions (locked in the brainstorm)

| # | Question | Decision |
|---|---|---|
| 1 | Is a plainly-opened `opencode -c` a captain? | **No, for delivery purposes.** A captain is a *squadrant-launched* session. A non-addressable captain becomes an explicit, loud "not deliverable" — never a silent `no-box` defer. |
| 2 | Does opencode expose a native channel? | **Yes — HTTP, not a peer socket.** `opencode --port N` serves `POST /session/{id}/prompt_async` and `GET /session`. `OpencodeHttpChannel` already exists and is verified; wiring it is the clean fix. |
| 3 | Extend `parseDraftFromScreen` to opencode's box grammar? | **Rejected.** It is the fragile path (false positives → keystrokes into a busy pane), unnecessary once the channel works, and it cannot fix the plainly-opened case. |
| 4 | Adopt a plainly-opened session? | **Rejected.** Verified: no TCP listener, no server registry file, `opencode attach` requires an explicit URL. There is nothing to adopt. |
| 5 | Fallback when no channel? | **Explicit "captain not deliverable" + one actionable out-of-band alert + cadence re-check.** The mailbox entry is never dropped. |
| 6 | How is the address conveyed? | **Dedicated persisted captain-address record** (not `sessions.json`). |
| 7 | Where is the record? | `<stateRoot>/<project>/captain.json` (`stateRoot` = `~/.config/squadrant/state`, `packages/cli/src/squadrantd.ts:581`). |
| 8 | Crew misroute | **Follow-up issue**, not bundled here. |

## 4. Data model

```jsonc
// <stateRoot>/<project>/captain.json
{
  "agent": "opencode",              // the agent that was ACTUALLY launched (post --agent override)
  "port": 51220,                    // opencode embedded HTTP server
  "sessionId": "ses_…",             // resolved after boot, directory-filtered (see §5.2)
  "directory": "/abs/realpath/of/project",   // realpath, NOT the config path (verified: opencode
                                             // returns /private/var/… on macOS)
  "launchedAt": "2026-09-17T…Z"
}
```

Rules:
- Written by the CLI at captain launch; read by the daemon (and by `squadrant ping`).
- **Session resolution is directory-exact on the realpath**: `realpath(session.directory) ===
  realpath(projectPath)`. Never a prefix match (`.worktrees/wt1` is inside the project path and must
  be excluded), never project-wide "newest" (§2 tests 9/10).
- Absent record ⇒ no squadrant-recorded address. For claude the deterministic socket path still
  applies (behaviour unchanged); for opencode it means the captain is not deliverable.

## 5. Design

### 5.1 Interactive captain boot (opencode)

- `buildAgentCmd` (`packages/agents/src/drivers/launch-cmd.ts:26`) passes `interactive: true`,
  `port`, and (on resume) `sessionId` to `driver.buildCommand` for the **captain** role. Only the
  opencode driver reads them (`packages/agents/src/drivers/opencode.ts:29`); claude returns earlier
  and codex/gemini ignore unknown options (verified: both read only
  `prompt`/`autoApprove`/`jsonOutput`).
- `SpawnOptions` gains `sessionId?: string` (`packages/agents/src/drivers/types.ts:27`). The
  opencode interactive command becomes `opencode [--session <id>] --port <N>`.
- **`-c` is never used.** Verified (§2 test 9): inside one repo, `-c` resumes the newest session
  *project-wide*, so a crew worktree session can be picked over the captain's own. Resume is always
  by explicit `--session <persistedId>`; a fresh start omits the flag.
- The free port is resolved once in `launchOne` **before** `launchOneWorkspace` is called (the
  `agentCmdFactory` is synchronous, `packages/core/src/launch-workspace.ts:194`; `getFreePort` is
  available at the CLI edge, `packages/cli/src/commands/crew.ts:5`).
- **Guard:** refuse to treat a directory that is not a git repo with ≥1 commit as an opencode
  captain project — opencode assigns it the shared `global` project, so session listing mixes
  directories (`docs/specs/2026-07-29-opencode-session-resume-spike.md` §T1).
- Readiness for the startup prompt: inject an opencode classifier in place of the claude-only
  `classifyStartupSurface` (`packages/workspaces/src/runtimes/cmux.ts:386`) — `loading` while the
  `"Ask anything"` splash marker is present, else `idle`. This mirrors the crew path
  (`packages/core/src/crew-spawn.ts:656`, `packages/core/src/crew-protocol.ts:46`). Verified: the
  current classifier reads a live opencode captain pane as `"loading"` (§2 test 7), so without this
  `deliverStartupPrompt` (`packages/core/src/launch-workspace.ts:41`) sends blind after the 30s
  readiness timeout and never confirms.
- The classifier returns only `loading`/`idle` for opencode (no reliable "working" signal);
  `deliverStartupPrompt`'s phase 3 then confirms by *screen change*, which is the correct behaviour
  for a submitted turn (`packages/core/src/launch-workspace.ts:79-93`).

### 5.2 Record write

The record is written for **every** captain launch (all agents), so `record.agent` is always the
truth of what was launched; `port`/`sessionId`/`directory` are populated only for opencode.

Sequence for an opencode captain:

1. Spawn the interactive TUI (`opencode --port <N>`, plus `--session <persistedId>` on a warm start).
2. Deliver the startup prompt through the pane — the existing `deliverStartupPrompt` with the
   opencode classifier. On a **cold** start this is what creates *and displays* the session
   (§2 tests 8/13); on a warm start it runs the startup checklist as usual.
3. Poll `GET /session` (bounded, ~60s) for a session whose `realpath(directory)` equals the
   project's realpath; take the newest `time.updated`; write the record atomically. On timeout,
   log and leave the record absent (⇒ not-deliverable, which is honest).
4. All later lifecycle deliveries go over HTTP to the persisted `sessionId`.

The whole step-3 task is fire-and-forget and bounded, so `--all` parallel launches are unaffected.
Step 2 is not new pane logic: delivering the startup prompt through the pane is exactly what the
claude captain does today.

Rejected alternative (verified, §2 tests 11/12): create the session via `POST /session` and focus it
with `/tui/select-session`. Both calls succeed, and `prompt_async` works, but the session is **not
rendered in the TUI** — the operator would never see the captain's notifications. A captain's
delivery target must be the session the operator is watching.

### 5.3 Agent-aware captain channel

- `ctx.captainChannels?: Partial<Record<string, ControlChannel>>` and
  `ctx.captainAgentFor?: (project: string) => string | undefined` join the existing
  `ctx.captainChannelMode` injection pattern (`packages/core/src/daemon/context.ts:166-167`,
  `packages/cli/src/squadrantd.ts:297-314`).
- The CLI edge builds both channels once: the existing claude peer channel, plus an
  `OpencodeHttpChannel` whose `portFor(project)` / session lookup read the captain record. A shared
  `buildCaptainChannels()` helper is used by `squadrantd.ts` **and** `ping.ts`
  (`packages/cli/src/commands/ping.ts:43-45`), so `squadrant ping` gets the same routing.
- `captainAgentFor(project)` = `record.agent ?? cfg.defaults.roles.captain.agent`. The record wins
  because `--agent` is a CLI flag that is not persisted in config. **"Needs a control channel"** is
  the fixed set `{claude, opencode}` — the two agents with a `ControlChannel` implementation
  (`packages/agents/src/claude/peer-channel.ts`, `packages/agents/src/opencode/http-channel.ts`).
- Migration note: a captain launched **before** this change has no record, so an
  `--agent`-overridden captain can be misclassified as its config agent until relaunched. §5.2
  writes the record on every captain launch going forward; the worst case is one actionable
  `no-channel` alert telling the operator to relaunch.
- `deliverToCaptain` (`packages/core/src/captain-channel.ts:52`) is **unchanged**; the delivery loop
  selects the channel before calling it. Per-outcome provenance (`via: "claude-peer" |
  "opencode-http"`) stays honest.

### 5.4 Delivery loop

In the send callback (`packages/core/src/daemon/delivery-loop.ts:397-443`). With
`captainChannel === "off"` `deliverToCaptain` returns not-handled and today's pane path runs
unchanged, so the logic below only applies when the channel mode is `shadow`/`on`:

```
agent   = captainAgentFor(project)            // record.agent ?? config captain agent
channel = captainChannels[agent]

if (channel) {
    r = deliverToCaptain(project, text, {channel, mode})
    if (r.handled) return                     // delivered / held at a human gate
    // returned because the channel reported gone/unsupported:
    if (agent === "opencode") {
        re-read the record; if the address is unchanged → throw DeferDelivery(null, "no-channel")
        // (a relaunch on a new port makes the next attempt succeed)
    }
    // claude falls through to the pane, unchanged
} else if (agent === "claude" || agent === "opencode") {
    // The agent has a control channel but we have no address for it.
    throw new DeferDelivery(null, "no-channel")
}
return cmux.send(surface, text, sendOpts)     // claude fallback; agents with no channel
```

- Opencode `404` from `prompt_async` (stale session id) triggers **one** re-resolve of the record
  (directory-filtered, per §5.2) + retry. Still failing ⇒ `no-channel`.
- Records are re-read with an mtime-cached reader so the 1s delivery tick does not stat the file
  needlessly.

### 5.5 Not-deliverable verdict

- `DeferReason` gains `"no-channel"` (`packages/core/src/delivery/defer-delivery.ts:9`), which flows
  into `DeliverDeferReason` and `STUCK_ALERT_TEXT` (`packages/core/src/daemon/delivery-loop.ts:31`).
  The message is actionable: *"the captain for `<project>` is not reachable over a control channel
  (agent `<agent>`); launch it with `squadrant launch <project>` — a manually opened `opencode -c`
  cannot receive lifecycle notifications."*
- **Prompt, not after 300 defers:** a `no-channel` defer is treated as immediately `stuck` for
  alerting purposes (edge-triggered once per episode via the existing `stuckNotified` set,
  `delivery-loop.ts:290`), so `notifyFault` / Telegram / the dashboard health row fire within
  seconds.
- **Cadence re-check:** the `no-channel` backoff cap is raised (≈5 min) above the existing 60s
  `projectBackoff` cap, and each attempt re-reads the record — so a relaunch heals delivery without
  a daemon bounce. The cursor never advances past an undelivered entry: **no message is lost.**

### 5.6 Claude is unchanged

Claude keeps its deterministic socket path and its pane fallback; it does not require a record.
Acceptance #3 is a regression guard, not a design goal.

## 6. State table

| State | Condition | Behaviour |
|---|---|---|
| addressable | record + channel + reachable | `channel.send`; cursor advances |
| addressable, unreachable | record present; port/socket dead | opencode: re-read record once, then `no-channel` + alert. claude: existing pane fallback |
| not addressable | agent needs a channel, no record, channel mode ≠ off | `no-channel` + alert immediately + cadence re-check; mailbox retained |
| agent without a channel | e.g. gemini captain | existing pane path (unchanged) |

## 7. Rejected directions

- **Extend `parseDraftFromScreen` for opencode's box** — fragile pane scraping, false-positive risk
  (typing into a busy pane), does not help the plainly-opened case. Rejected.
- **Adopt a plainly-opened `opencode -c`** — verified to have no TCP listener, and `opencode attach`
  requires an explicit URL (there is no server registry file; `--mdns` is a launch flag, so it does
  not help adoption either). Nothing to adopt. Rejected.
- **Deterministic port derived from the project name** — carries no agent identity (breaks under
  `--agent` override) and adds collision handling. Rejected in favour of the record.
- **`-c` for captain resume** — verified to pick the newest session **project-wide**, so a crew
  worktree session can win over the captain's own (§2 test 9). Rejected; resume is `--session <id>`.
- **Create the session out-of-band (`POST /session` + `/tui/select-session`)** — both work, but the
  session is not rendered in the TUI, so the operator never sees the captain's notifications
  (§2 tests 11/12). Rejected.
- **Fixing the crew-side resolver in this change** — adjacent but not required for the captain
  path; bundling it would widen the blast radius. See §9.

## 8. Acceptance criteria

- [ ] An opencode captain **launched by squadrant** receives crew lifecycle notifications over the
      opencode HTTP channel — no pane scraping, `via opencode-http` in the daemon log.
- [ ] **Cold start:** a first-ever opencode captain resolves and persists a session id whose
      `directory` is the project realpath, and later notifications render in the captain pane.
- [ ] **Warm start:** the captain resumes by `--session <persistedId>` (never `-c`) and delivery
      works without re-resolution.
- [ ] A captain that cannot be used as a delivery target produces a clearly-defined, actionable
      error within seconds (not an unbounded `no-box` deferral).
- [ ] Claude captains behave exactly as before (existing tests stay green).
- [ ] `docs/reference.md` documents how to run an opencode captain so delivery works.
- [ ] End-to-end smoke test passes live: `squadrant launch <project> --agent opencode` → captain
      boots interactive with a port → record written → a spawned crew's `task.done` is delivered and
      visible in the captain pane.
- [ ] Launching an opencode captain from a directory that is not a git repo with ≥1 commit is
      refused with a clear message (shared `global` project).

## 9. Out of scope / follow-ups

- **Crew misroute (new issue).** `OpencodeHttpChannel.resolveSession` picks the newest session
  project-wide; a crew with a newer session in another directory of the same project could receive
  another crew's message. `TaskRecord.cwd` exists (`packages/shared/src/types/control.ts:54`), so
  directory-scoped resolution is wireable. File separately.
- **Captain turn-end / SSE liveness** — captains only need delivery; turn-end detection for the
  captain role belongs to #628.
- **`opencode` interactive ignores `model`** (`packages/agents/src/drivers/opencode.ts:29`) — the
  captain may run opencode's global default rather than `defaults.roles.captain.model`. Fixing it
  also changes crew behaviour, so it is a separate issue, not bundled here.
- **`command` role** shares the delivery loop and the same agent-aware selection benefits it, but
  command is a one-shot spawn (`packages/cli/src/commands/command.ts`); no captain record is written
  for it here.
- **HTTP server authentication** — the captain's opencode server is unsecured like crew servers
  today (design doc §2 notes this predates the spec). Unchanged; no widening.

## 10. Open risks

| Risk | Mitigation |
|---|---|
| Port chosen at launch is taken before the TUI binds (TOCTOU) | `getFreePort` already used by crews; on bind failure the record is stale → `no-channel` alert (loud, not silent) |
| Record stale after a manual captain restart | Detected as "addressable, unreachable" → re-read + alert; operator relaunches |
| Cold start: no session exists until a turn is started (§2 test 8) | The startup prompt delivered through the pane creates it; the resolver polls up to ~60s. If the prompt never lands, no record → not-deliverable alert (bounded, honest) |
| `directory` is a realpath, the config path is not (§2 test 10) | Compare `realpath()` on both sides; never string-compare the config path |
| A non-repo directory gets opencode's shared `global` project | Guard refuses such a launch (§5.1); the exact-directory filter is the second line of defence |
| Several sessions in the captain's own directory | Take newest by `time.updated` **within** the exact realpath; if the operator opened another session there it is still the same project context |
| Multiple captains for one project (old + new surface) | Record is per project; the newest launch overwrites it. Not handled further (YAGNI) |
| Pre-existing captain without a record + `--agent` override ≠ config | Misclassified until relaunch; worst case is one actionable `no-channel` alert (§5.3). Self-heals on the next `squadrant launch` |

## 11. Implementation estimate

Size: **hard** (3 packages, ~10 files + tests). Suggested waves, each independently verifiable:

1. **Launch + record (A, B)** — interactive opencode captain boot (`interactive`/`port`/
   `sessionId`, no `-c`), non-repo guard, opencode startup classifier, cold/warm record write.
   *Verify:* cold `squadrant launch <project> --agent opencode` → TUI with `--port`, record’s
   `sessionId` has `directory` == project realpath; relaunch → `--session <id>` resumes and the
   startup prompt lands.
2. **Channel (C)** — `captainChannels` + `captainAgentFor`, opencode channel wired to the record
   (realpath-exact session resolution, 404 re-resolve), shared builder used by `ping`.
   *Verify:* daemon log shows `delivery … outcome=delivered` with `via opencode-http`; message is
   visible in the captain pane.
3. **Not-deliverable (D)** — `no-channel` reason, immediate edge-triggered alert, cadence backoff,
   full alert text.
   *Verify:* a plainly-opened `opencode -c` captain → actionable alert within seconds, no
   `no-box` defer flood, message still in the mailbox.
4. **Docs + live smoke test** — `reference.md`, end-to-end crew→captain notification.

## 12. References

- `packages/workspaces/src/runtimes/cmux.ts:164` `parseDraftFromScreen`; `:386`
  `classifyStartupSurface`
- `packages/core/src/delivery/defer-delivery.ts:9` `DeferReason`;
  `packages/core/src/delivery/captain-delivery.ts:24` `DeliverDeferReason`
- `packages/core/src/daemon/delivery-loop.ts:31` `STUCK_ALERT_TEXT`; `:397-443` channel-first send
  callback; `:499-520` stuck alert
- `packages/core/src/captain-channel.ts:52` `deliverToCaptain`;
  `packages/cli/src/lib/captain-channel-factory.ts:132` `buildCaptainChannel`
- `packages/agents/src/opencode/http-channel.ts:111-139` `resolveSession` (project-wide newest)
- `packages/agents/src/drivers/launch-cmd.ts:100-111`; `packages/agents/src/drivers/opencode.ts:29`;
  `packages/agents/src/drivers/types.ts:27`
- `packages/agents/src/drivers/codex.ts:29-33`, `packages/agents/src/drivers/gemini.ts:22-27` (both
  ignore unknown `SpawnOptions`, so passing `interactive`/`port`/`sessionId` is inert for them)
- `packages/cli/src/commands/launch.ts:41-46, 156-238`; `packages/cli/src/squadrantd.ts:297-314`
- `packages/core/src/launch-workspace.ts:41, 79-93, 170 (onCreated), 194 (agentCmdFactory)`
- `packages/cli/src/commands/crew.ts:139-141` (crew-side channel wiring, project-wide `portFor`)
- Design doc: [`2026-08-13-agent-control-channel-design.md`](2026-08-13-agent-control-channel-design.md)
  (§2 records "daemon → captain … captain (always claude)")
- Resume spike: [`2026-07-29-opencode-session-resume-spike.md`](2026-07-29-opencode-session-resume-spike.md)
  (T1 non-repo hazard; `-c` / `-s <id>`). **Caveat:** its E2 finding "directory wins over recency"
  was measured across *different repos*; §2 test 9 here shows that inside ONE repo with worktrees,
  `-c` is project-wide. Do not use `-c` for a captain.
- Live verification scripts: `/var/folders/rv/y35yc8ns24g7js2zg0mtzs3r0000gn/T/opencode/oc786/`
  (throwaway). Key ones: `verify7.sh` (warm `-s` end-to-end + TUI visibility), `verify9.sh` (cold
  start via pane input + visibility), `verify6.sh` (realpath filter, `POST /session`, invisible
  session), `verify5.sh` (cold start = 0 sessions, `-c` project-wide), plus the local pane captures
  `screen-captain.txt` / `screen-crew.txt` run against the built parser.
