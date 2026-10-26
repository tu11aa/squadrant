# Daemon restart audit (2026-10-26)

Why the squadrant daemon kept restarting on 2026-10-26, which code paths can restart it, and
what an extra message in a session can come from. Evidence first: every claim below cites a
log line, a code path, or an isolated reproduction.

All times are UTC (the daemon log's clock). Local time is UTC+7.

## Names used here

| Name | Meaning | Where |
|---|---|---|
| `ensureDaemon` | Self-heal on CLI startup: reconciles the launchd plist and starts the daemon | `packages/core/src/launchd.ts` |
| `reregisterDaemon` | What `squadrant heal daemon` runs: reconcile, then always `kickstart -k` | `packages/core/src/launchd.ts` |
| `restartDaemonIfRunning` | `kickstart -k` after a config change the daemon caches | `packages/core/src/restart-daemon.ts` |
| `squadrantdCall` | CLI → daemon socket call with a self-heal fallback | `packages/cli/src/commands/crew-control.ts` |
| drift | The plist on disk differs from what this process would write | `computeDaemonDrift` in `launchd.ts` |
| program drift | The drift is in ProgramArguments (node binary or `squadrantd.js` path), not just PATH | `programChanged` |
| restart notice | The "⚠️ Daemon restarted → vX" captain message | `packages/cli/src/lib/daemon-restart-broadcast.ts` |

## 1. Every restart trigger in code

A daemon restart shows in the log as `exit ... reason=SIGTERM ppid=1 launchd=true` followed by
`boot`. launchd sends that SIGTERM only for `launchctl kickstart -k` or `launchctl bootout`. A
plain `kickstart` (no `-k`) does nothing to a running service. It only starts one that is down.

| # | Trigger | Who can fire it | launchctl calls | Restarts a running daemon when |
|---|---|---|---|---|
| T1 | `ensureDaemon` from CLI startup (`packages/cli/src/index.ts`) | Every `squadrant` invocation except `crew list/read/tasks`, `sessions`, `whoami`, `gate` and `SQUADRANT_DAEMON_SKIP`. Only **acts** for `SQUADRANT_ROLE=captain` or `launch`/`init`. Any other caller only prints a stderr note | `bootstrap` + plain `kickstart` always; `bootout` first on program drift | Program drift, **and** the registered entry is either this install, a same-manager version bump, or a file that no longer exists. A different install that still exists is refused (#670 guard) |
| T2 | `ensureDaemon` from the `squadrantdCall` fallback | Same gate as T1. In-process it is a no-op once T1 ran (`restartInFlight`), so it is only live for the commands T1 skips (`crew list/read/tasks`) | as T1 | as T1. It runs on **any** socket error, including a timeout on a busy daemon or an error the daemon reported |
| T3 | `squadrant heal daemon` → `reregisterDaemon` | Anyone, any role (explicit operator path) | `bootout`+`bootstrap` on program drift or a moved log path, then `kickstart -k` (retried) | Always. That is its job (#729) |
| T4 | `squadrant heal captain` | Anyone | `kickstart -k` | Always |
| T5 | `restartDaemonIfRunning`: `projects add` (unless `--no-restart`), `config set <daemon-cached key>`, `telegram setup` | Anyone, **any role** | `kickstart -k` | Whenever `~/.config/squadrant/squadrant.sock` exists |
| T6 | launchd itself (`KeepAlive`, `ThrottleInterval` 10s) | — | — | Only after the daemon exits on its own (crash) or at login. Never shows as `SIGTERM` |

`squadrant mcp` (registered at user scope in `~/.claude.json` as `squadrant mcp`) has no
restart path of its own. It reaches the daemon only through T1 (CLI startup) and T2 (its tool
calls use `squadrantdCall`). `projects remove` does not restart: 07:04:05 and 08:15:16 below
have no exit line.

## 2. Today's restarts, one by one

Method: every `exit … reason=SIGTERM` line in `~/.local/state/squadrant/logs/squadrantd.log`
matched to the Bash commands in that hour's Claude Code transcripts (`~/.claude/projects/*/*.jsonl`).
Only one session ran daemon-touching commands: the squadrant captain.

| Exit (log) | Trigger command (captain transcript, start time) | Path | Notice sent |
|---|---|---|---|
| 05:50:45.547 | `squadrant heal daemon` (05:50:37); output `✔ daemon kickstart complete` | T3 | no (same build) |
| 07:02:02.822 | `npm i -g squadrant-0.31.1.tgz; … squadrant heal daemon` (07:01:55). Its `pgrep` printed new pid 69844, the same pid as the `boot` line | T3 | yes (0.31.0 → 0.31.1) |
| 07:02:27.017 | `git init …; squadrant projects add mcptest $P; squadrant launch mcptest --fresh` (07:02:24.9) | **T5** | no |
| 07:04:19.367 | `squadrant projects add mcptest $P; squadrant launch mcptest` (07:04:18.7) | **T5** | no |
| 07:42:07.380 | `pnpm build && npm pack && npm i -g … && squadrant heal daemon` (07:41:42) | T3 | yes, "dev build" |
| 07:54:13.189 | same build/install/heal chain, then `crew spawn smoke4` (07:53:57) | T3 | yes, "dev build" |
| 08:08:49.680 | same chain, then `crew spawn smoke5` (08:08:34) | T3 | yes, "dev build" |
| 08:34:36.781 | `gh pr checks 1049 --watch …; … npm i -g … && squadrant heal daemon` (08:32:36; the heal ran after a 2-minute CI wait) | T3 | yes, "dev build" |
| 08:34:53.911 | `git init …; squadrant projects add mcptest $P; squadrant launch mcptest --fresh` (08:34:53.150) | **T5** | no |
| 08:56:02.432 | `git pull; pnpm build; npm i -g …; squadrant heal daemon` (08:55:41) | T3 | yes, "dev build" |
| 08:59:02.897 | `npm i -g ./squadrant-0.31.1.tgz; squadrant heal daemon` (08:58:58) | T3 | yes, "dev build" |
| 09:05:08.267 | crewcompact build + `npm i -g … ; squadrant heal daemon` (09:04:52) | T3 | yes, "dev build" |

**Verdict:** 12 of 12 restarts are explained. 9 came from `heal daemon` (T3), run by the captain
after installing a branch build. 3 came from `squadrant projects add mcptest` (T5), which the
captain ran while recreating the throwaway `mcptest` project for MCP smoke tests. No restart
came from `ensureDaemon` (T1/T2), from `squadrant mcp`, or from a crash (T6).

### The "unexplained" 08:34:36 → 08:34:53 pair (17 s)

Two separate captain commands, not a race:

1. 08:34:36: the `heal daemon` at the end of the 08:32:36 chain, which waited on `gh pr checks --watch` first.
2. 08:34:53: `projects add mcptest`. It started at 08:34:53.150, and the exit landed 0.76 s later.
   The new mcptest captain only shows up after that (`[captain/runtime] mcptest pid=85126 → alive`
   at 08:35:04), so its `squadrant mcp` child came after the restart and cannot have caused it.

07:02:02 → 07:02:27 (25 s) has the same shape: heal, then `projects add`.

### Operator hypothesis: the user-scope MCP server

Tested and **rejected for today**. Evidence:

- **No `ensureDaemon` restart happened today.** `ensureDaemon` can only stop a running daemon via
  `bootout`, which needs program drift, and program drift always writes the plist first
  (`reconcilePlistAndService`). `~/Library/LaunchAgents/com.squadrant.daemon.plist` was last
  modified **Oct 21 15:17**, so nothing reconciled it today.
- **Session starts without restarts.** Each Claude session start and each `/compact` spawns a fresh
  `squadrant mcp` child (with `SQUADRANT_ROLE=captain` for captains, since it inherits the captain's
  env). Today that happened many times with no restart: captain compacts at 07:18:49, 08:50:10 and
  08:57:25, crew spawns smoke4 (07:54:18), smoke5 (08:08:54) and s6, and the mcptest captain
  launches (each at least 1 s *after* its restart).
- **Isolated reproduction.** Temp `HOME`, temp `SQUADRANT_CONFIG` and `SQUADRANT_STATE_DIR`, and a
  fake `launchctl` first on `PATH` that only records its arguments, so no call reached the real
  launchd. Results:

  | Scenario | launchctl calls recorded |
  |---|---|
  | A. `projects add demo` (no role), socket file present | `kickstart -k gui/501/com.squadrant.daemon` (+ attribution line `action=kickstart-k reason="project registration"`) |
  | B. 3 concurrent `squadrant mcp` children, `SQUADRANT_ROLE=captain`, plist already matching | 3 × (`bootstrap` + plain `kickstart`). No `-k`, no `bootout` |
  | C. `node <worktree>/dist/index.js mcp` as captain, plist registered to the global install (which exists) | none. The #670 banner "refusing to restart the daemon…" is printed and the plist is unchanged |
  | D. as C, but the registered entry no longer exists | `bootout` + `bootstrap` + `kickstart`. The worktree build **takes over the plist** |
  | E. as D, but a crew (no `SQUADRANT_ROLE`) | none. Only the stderr note |

**PR #1053 (exempt `mcp` from startup `ensureDaemon`)** does not explain or remove any of today's
restarts. It removes two latent risks: a captain-role `mcp` child taking the plist over
(scenario D), and repeated `bootstrap`/`kickstart` calls plus stderr notes on every session start.
The only real-world window for D is while `npm i -g` has removed the old package directory and
not yet written the new one. Worth having, but it is not today's cause.

A crew's `mcp` child cannot act on the global plist: crews have no `SQUADRANT_ROLE` (scenario E).
The registered command is the bare `squadrant`, so it resolves to the global install on `PATH`,
not to a worktree `dist/index.js`.

## 3. Extra messages in a session

| Source | Evidence | Status |
|---|---|---|
| Restart notice on every same-version reinstall | 8 notices today (07:02:02, 07:42, 07:54, 08:08, 08:34:36, 08:56, 08:59, 09:05), each to every live captain (seq 321/325/328/333/338/339/341/344 in `inbox/squadrant.log`). 7 of them say "(dev build)": the signature is `version::buildMtime`, so every `npm i -g` of a rebuilt branch counts as a change | Root cause confirmed |
| `/compact` typed twice | `captain-compact squadrant: /compact sent` at 08:57:25.582 **and** .896 for one `captain compact`. Code: `start.ts` fires `compact.tick()` every 1 s without awaiting; `tryOne` awaits `cmux.send` and only then deletes the pending entry, so a tick that starts while a send is in flight sends again. Reproduced in a unit test (send held open, second tick fires → `send` called twice). `crew-compact.ts` has the identical structure and fails the same test | Root cause confirmed (both) |
| `squadrantdCall` re-sends on any error | Code: any `sendRequest` rejection, including `request timed out` (daemon busy past 5 s, request possibly already processed) and a daemon-reported error, runs `ensureDaemon` and then re-sends the same request up to 3 times. Callers include `event` (captain messages, task events), `dispatch` (crew spawn), `purge`. Reproduced in a unit test (timeout → 4 sends). Not observed in today's log; this is a code-path risk, not a confirmed incident | Risk, unconfirmed in logs |

## 4. Attribution (shipped on this branch)

Before it touches launchctl, every restart path now appends one line to the daemon log:

```
[squadrant-cli] 2026-10-26T09:24:46.507Z restart-trigger action=kickstart-k reason="project registration" pid=15711 ppid=15709 argv="projects add" role=- crewTask=- install=/…/dist/index.js
```

| Path | `action` | `reason` |
|---|---|---|
| T1/T2 `ensureDaemon`, only when there is drift | `bootout+bootstrap` or `plist-write (no restart)` | `ensureDaemon <cli startup / squadrantdCall fallback>; drift=<version (entry a -> b) / path (entry or node a -> b) / plist (PATH/env only) / plist missing>` |
| T3 `heal daemon` | `reregister+kickstart-k` | `heal daemon; drift=…[; log moved a -> b]` |
| T4 `heal captain` | `kickstart-k` | `heal captain (reload liveness registry)` |
| T5 | `kickstart-k` | `project registration` / `config <key>` / `telegram config` |

A no-drift `ensureDaemon` is not logged. Its plain `kickstart` cannot restart a running daemon,
and logging it would add a line for every captain CLI call. Covered by
`packages/core/src/__tests__/restart-attribution.test.ts` and
`packages/cli/src/__tests__/restart-attribution-cli.test.ts`.

## 5. Fixes (applied on this branch after the captain's go)

1. **Duplicate `/compact`.** Add a re-entry guard on `tick()` in `captain-compact.ts` and
   `crew-compact.ts`. A test proves one `/compact` per request when a tick fires mid-send.
2. **Restart notice.** Make the signature `version::installPath` instead of the build mtime, so a
   same-version, same-path reinstall stays silent. Add a 5-minute cooldown so the notice never
   fires twice in a row (covers an A→B→A path flip), and migrate a legacy mtime signature silently.
   Today this would have sent 1 notice (07:02:02, the real 0.31.0 → 0.31.1 upgrade) instead of 8.
3. **`squadrantdCall`.** Fall back (`ensureDaemon` + re-send) only on `cannot reach squadrantd
   socket`. Throw timeouts and daemon errors as-is: the daemon already has the request.

## 6. Follow-ups (not fixed here)

- **T5 restarts for `projects add` / `config set`.** They are deliberate (commit 118ec6c: the daemon
  caches config), but each one is a full restart that bounces every project. A config hot-reload
  over the socket would remove 3 of today's 12. Bigger change.
- **Captain workflow.** `npm i -g <branch tgz> && squadrant heal daemon` was 9 of today's 12
  restarts. Expected for testing a branch build, but worth a lighter path (e.g. reuse the isolated
  daemon harness from #1046) so live-daemon bounces are rare.
- **Scenario D** (a captain-role process takes the plist over while the registered entry is
  briefly missing): PR #1053 closes it for `mcp`. Any other captain-role CLI call during the
  `npm i -g` window still can.
- **`squadrantdCall` retry on `ECONNRESET` mid-request.** `cannot reach squadrantd socket` is also
  raised for an error after connect, when the request may already have landed. Splitting
  connect-phase from post-write errors would make the retry strictly safe.
