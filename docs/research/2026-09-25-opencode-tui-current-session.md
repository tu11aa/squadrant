# opencode TUI current-session detection — research (#861 follow-up)

**Date:** 2026-09-25
**opencode version probed:** 1.18.32 (`/Users/q3labsadmin/.opencode/bin/opencode`)
**Method:** read-only probe of a scratch `opencode --port 45999 serve` in `/tmp/oc-probe`,
attached a real TUI (`opencode attach http://127.0.0.1:45999 -s <ses> --mini`), and subscribed
passively to `GET /event` (SSE). No live captain server touched, no prompt POSTed to a live
session, `~/.config/squadrant` untouched. All probe processes killed before finishing.

## Verdict: **NOT feasible** (no ground-truth endpoint for "session the TUI is showing")

opencode 1.18.32 does **not** expose the TUI's currently-displayed session over HTTP. The only
TUI-session API is one-directional (server → TUI navigation), and the endpoint that looks
promising (`/api/session/active`) means something else entirely. A reliable reconcile can still
be built on a weaker signal (SSE of the latest prompt), but it is inference, not ground truth.

---

## Q1. Does the opencode server expose the TUI's current/active session?

**No.** Full path inventory from `GET /doc` (OpenAPI 3.1) — the complete set of TUI- and
session-related routes:

| Route | Method | What it actually does |
|---|---|---|
| `/tui/select-session` | POST | **Inbound**: tells the TUI to *navigate to* `{sessionID}`. Description: "Navigate the TUI to display the specified session." |
| `/tui/publish` | POST | Publish a TUI event (`tui.prompt.append` / `tui.command.execute` / `tui.toast.show` / `tui.session.select`). Inbound only. |
| `/tui/control/next` | GET | Server-side request queue the TUI polls for commands. |
| `/api/session/active` | GET | "Retrieve **foreground Session drains** currently owned by this OpenCode process. Sessions absent from the result are **inactive**." Response `{"data":{}}` at idle even with a TUI attached. |
| `/session/status` | GET | Per-session run status (`{}` at idle). |
| `/session` | GET | All sessions in the project; **no** "current". |
| `/path`, `/api/location` | GET | The **server process's** cwd — not the TUI's viewed session. |
| `/event` | GET (SSE) | Broadcast stream (see below). |

### `tui.session.select` is inbound-only — proven two ways

1. **Schema direction.** `EventTuiSessionSelect` (`{"type":"tui.session.select","properties":{"sessionID":"^ses..."}}`)
   is listed in `/tui/publish`'s request body — it is a command a *client* publishes *to* the TUI.
2. **Binary inspection.** The only call site of `selectSession` in the compiled binary is the SDK
   method that POSTs to `/tui/select-session` (used by external controllers, e.g. squadrant/cmux).
   The TUI's own handler is receive-only:
   `b.on("tui.session.select", (r,{workspace:B}) => { ... t.navigate({type:"session", sessionID:r.properties.sessionID}) })`.
   A user pressing the in-TUI session switcher navigates locally and emits **nothing** upstream.

**Echo caveat:** because the server re-broadcasts published TUI events, POSTing
`/tui/select-session` *does* produce a `tui.session.select` frame on `GET /event`
(`data: {"type":"tui.session.select","properties":{"sessionID":"..."}}`). That frame is an echo
of the command we sent, **not** a report of state. Treating it as ground truth would be exactly
the "echo chamber" failure mode.

### What `/api/session/active` actually is

Its `SessionActive` schema is `{"type":"running"}` — i.e. it lists sessions with **in-flight
foreground work (drains)**, not the viewed session. It stayed `{"data":{}}` while a TUI was
attached and idle, and did not change when we navigated the TUI. It is a **busy/working**
signal, not a **viewed** signal. Unusable for this purpose.

---

## Q2. Map a titled cmux surface → opencode process → `--port`

**Yes — this chain is fully available and already half-implemented.**

### Step 1: surface → tty (cmux)

`cmux tree --json --id-format refs` includes `tty` per surface:

```json
{"ref":"surface:12","title":"⚓ squadrant-captain","tty":"ttys000","type":"terminal"}
```

Squadrant already parses `cmux tree` in `packages/workspaces/src/runtimes/cmux.ts:104`
(`CmuxTreeJson`) and `:648` for surface titles — but the existing typed shape **drops `tty`**;
the parser only consumes `ref` / `surface_ref` / `title`. Extending it to read `tty` is a
one-field change.

### Step 2: tty → pid

`ps -axo pid=,tty=,command=` (or `lsof /dev/ttysNNN`) resolves the terminal to the resident
processes. Verified live:

```
$ ps -axo pid=,tty=,command= | grep ttys005
49389 ttys005  opencode --port 49616
```

### Step 3: pid → `--port`

`parseLiveOpencodeServers` in `packages/core/src/opencode-session.ts:57` already parses
`ps -axo pid=,command=` into `{pid, port, sessionId?}` for `opencode ... --port <n>` lines.
`discoverLiveOpencodeServer` (`:104`) matches by **session id** first, then **process cwd**
(`lsof -d cwd`). For a surface → port mapping the join key is **pid**, which neither function
currently returns from a tty — but the missing piece is only `tty → pid` (step 2), which is a
trivial `ps`/`lsof` call. Everything downstream (`pid → port`, `port → HTTP`) exists.

**Mapping recipe:** `cmux tree --json` → surface title `⚓ <project>-captain` → `tty` →
`ps -axo pid=,tty=,command=` → opencode pid → `--port` → `http://127.0.0.1:<port>`.

---

## Q3. If the current session is not exposed, what is the best available signal?

### Best signal: SSE `message.updated` / `session.status` on `GET /event`

Subscribing to `GET /event` and watching for the latest **user-typed prompt** is the strongest
available inference. Verified event types during a prompt (on our probe session):

```
message.updated, message.part.updated, message.part.delta,
session.updated, session.status, session.idle,
step-start, step-finish, text, session.diff, busy, idle
```

The relevant payload is `EventMessageUpdated` → `properties.info.sessionID` with
`role:"user"`; a new user message id whose `sessionID` is not the recorded one means the
operator has typed into a different session. `session.status` / `session.idle` also carry a
`sessionID` and can be used as corroboration.

### Reliability: partial — inference, not ground truth

- **Works:** tells you *which session was last prompted*, which in practice is usually the
  session on screen (you type where you look).
- **Fails / noisy:**
  - Browsing sessions without typing emits nothing — a reconcile that only watches prompts
    will miss a user who switched to read session B and never typed.
  - Every crew/daemon delivery to any session on the same server also emits
    `message.updated`. If the captain server ever hosts more than the captain's own session,
    external traffic pollutes the signal. (Mitigation: only count `role:"user"` messages,
    and only those whose `sessionID` differs from the recorded address.)
  - An `opencode attach` TUI shares the **same server** as the captain, so the event stream is
    shared — good (one socket) but the signal is multiplexed across all sessions on that port.
  - SSE is a long-lived connection: reconcile must subscribe continuously or re-derive
    "latest" from `GET /session/{id}/message` snapshots at poll time (no replay/cursor on
    `/event` beyond `server.connected`).

### Fallback / snapshot alternative

At each reconcile tick, `GET /session` gives `time.updated` per session scoped by project. The
newest `time.updated` in the captain's directory is a **very weak** proxy (any background
update, including daemon deliveries, bumps it). Do **not** use "newest updated" as the current
session — that is the same class of silent misroute #789 already fixed for cold starts.

### Strictly better if available: TUI-side hook

There is no TUI plugin/hook in 1.18.32 that emits "user navigated to session X" server-side.
`/tui/control/next` is the reverse direction. So no exact signal exists today.

---

## Recommended reconcile design (≤10 lines)

1. Extend `CmuxTreeJson` to capture `tty`; add `surfaceTty(title)` → map `⚓ <project>-captain`
   surface to its tty via `cmux tree --json`.
2. Add `tty → opencode pid → port`: `ps -axo pid=,tty=,command=` filtered to `opencode… --port`,
   reusing `parseLiveOpencodeServers`' regex.
3. Subscribe **continuously** to `GET /event` on that port (the daemon already owns the socket);
   track the most recent `message.updated` with `info.role === "user"`.
4. On a user-message event whose `sessionID ≠` recorded address, update the captain record
   (candidate = that session; require 2 consecutive ticks or an explicit confirm before write).
5. Reconcile **only** when `discoverLiveOpencodeServer` (session-id-first) disagrees with the
   record; never overwrite on the weak "newest `time.updated`" heuristic.
6. Log every reconcile as inference, not ground truth; expose the last-observed prompt time so a
   stale inference is visibly stale. Do not treat `tui.session.select` echoes as state.
