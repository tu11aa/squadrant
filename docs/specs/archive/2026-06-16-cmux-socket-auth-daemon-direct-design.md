# cmux Socket Auth for Daemon-Direct Delivery — Design

> **✅ Shipped** (PR #341, #342, #351, 2026-06-16). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Issue:** #348 (part of #332)
**Status:** Implemented (this PR delivers the autoconfig; #332 delivery wiring is opt-in / follow-up)
**Date:** 2026-06-16 (reconstructed 2026-06-17 — the original doc was written but never committed and was lost; this REPLACES it)

> This document reconstructs the lost #348 design from recovered research
> (claude-mem session S5306/S5307, observations 18379–18395) plus live
> verification against `~/.config/cmux/cmux.json` on the dev machine.

---

## 1. Problem

Daemon-direct notification delivery (`defaults.daemonDirectCmux`) lets the
launchd-managed cockpit daemon (`cockpitd`) drive cmux **directly** — shelling
out to the `cmux` CLI to send notifications into crew/captain surfaces — instead
of routing through the captain-owned notify-relay.

This **only works today because the dev machine carries a MANUAL config block**:

```jsonc
// ~/.config/cmux/cmux.json   [cockpit-dbg] block
"automation": {
  "socketControlMode": "automation"
}
```

On a **clean install** that block does not exist, so daemon-direct **silently
fails**: the cmux control socket rejects the daemon's connection. #348 makes
cockpit write that config itself.

---

## 2. Root Cause

The cmux control socket reads `automation.socketControlMode` to decide who may
connect:

- **`cmuxOnly`** (the default): at `accept()` the socket performs a
  **peer-credential / process-parentage check** — it walks the connecting
  process's parent chain and rejects any peer that is **not descended from the
  cmux app**. `cockpitd` runs under launchd (PPID ⇒ 1), is NOT a cmux
  descendant, and is therefore **rejected** ("Access denied — only processes
  started inside cmux").
- **`automation`**: no parentage check. Any same-user process may connect.

**Fix:** set `socketControlMode = "automation"`.

### Security note

`automation` carries **no password**, but for a **same-user threat model** the
security is **equivalent to password mode**: any same-user process can already
invoke the `cmux` CLI, which implicit-loads a saved password. A local attacker
who can run our probe can already run `cmux` directly. We therefore choose the
no-password `automation` mode rather than managing a secret.

---

## 3. Verified cmux Config Model

Established by live inspection (do not re-derive — these are load-bearing):

1. **The socket reads its mode from cmux *defaults* (`com.cmuxterm.app`) at
   LAUNCH only.** Changing the mode requires a **cmux restart** to take effect
   *on the socket*.
2. **cmux watches `~/.config/cmux/cmux.json` LIVE** and syncs file-managed keys
   into defaults **immediately** while running. (So writing the file updates
   defaults at once — but per (1), the *already-bound socket* keeps its old mode
   until restart.)
3. **cmux does NOT rewrite `cmux.json` on launch** — comments and formatting are
   preserved. Our writer must do the same (comment-preserving JSONC merge).
4. **If cmux is NOT running at write time**, the live watcher will not sync. The
   value still applies on the *next* cmux launch (file-managed keys load at
   boot), and our daemon-start re-check re-probes to recover.

### ⚠️ Contaminated prior research

Earlier research claimed the cmux socket is reachable from **any** process. That
test was **contaminated**: it ran inside a cmux pane, so the probe kept cmux
ancestry even under `env -i`. **Do not trust it.** A faithful probe MUST run
from a process with **no cmux ancestor** (PPID ⇒ 1, launchd-reparented).

---

## 4. Implementation

### 4.1 Comment-preserving JSONC merge — `src/lib/cmux-config.ts`

Use **`jsonc-parser`** (`modify` + `applyEdits`) to write **only**
`automation.socketControlMode = "automation"` into `~/.config/cmux/cmux.json`,
preserving every existing comment and key.

- **Idempotent**: if the key is already `"automation"`, it's a no-op
  (`changed: false`).
- **Missing file**: write a minimal cockpit-managed JSONC template carrying just
  the automation block, so a clean install works before cmux ever creates its
  own template. (cmux merges its template keys on next launch; ours is a strict
  subset, so there is no conflict.)
- Returns `{ changed, alreadySet, path }`.

### 4.2 Idempotent non-cmux probe — `src/lib/cmux-probe.ts`

`probeCmuxDaemonDirect()` answers: *can a non-cmux process reach the cmux control
socket right now?* — the **hybrid gate** for choosing daemon-direct vs relay.

Faithfulness requires escaping cmux ancestry (§3). Mechanism:

1. Spawn a detached **launcher** that spawns a detached **worker** and exits
   immediately → the worker is **orphaned and reparented to launchd**
   (`process.ppid ⇒ 1`).
2. The worker **waits until `process.ppid === 1`** (bounded poll), then runs a
   cheap read-only cmux command (`workspace list --json`).
3. The worker writes `{ code, stderr }` to a temp file; the caller reads it.

`classifyProbe({ ok, stderr })` (pure, unit-tested) maps the result:

- success ⇒ `"reachable"` (daemon-direct viable)
- stderr matches access-denied / "only processes started inside cmux" ⇒
  `"denied"` (still `cmuxOnly` on the live socket — restart needed)
- anything else (cmux missing, timeout) ⇒ `"unknown"` (fail soft → stay on relay)

The spawn runner is injectable so unit tests never spawn a real process; the
classifier is tested in isolation.

> **Production note:** `cockpitd` itself already runs PPID ⇒ 1 under launchd, so
> the daemon can probe by simply attempting a cmux call (`DaemonCmux.isAvailable`)
> — it does not need the orphan trick. The orphan-escape exists for the
> **setup-time CLI** (`cockpit cmux autoconfig`), which may be invoked from
> inside a cmux pane and would otherwise report a contaminated result.

### 4.3 Semi-automatic, one-time restart prompt — `src/lib/cmux-autoconfig.ts`

`ensureCmuxAutoConfig()` ties it together:

1. `ensureSocketAutomation()` — write config if needed (§4.1).
2. `probeCmuxDaemonDirect()` — check the live socket (§4.2).
3. If the probe is `"denied"` (config written but socket still on the old mode),
   surface a **one-time** prompt: *"Restart cmux to enable daemon-direct
   delivery."* A state marker (`~/.config/cockpit/cmux-autoconfig.state.json`,
   `{ promptedRestart: true }`) ensures we **do not nag** on subsequent runs.
4. Return a structured result so the caller (CLI prints it; daemon logs it once).

Per the "semi-automatic over fully-automatic" and "prefer permanent rules over
temp fixes" principles, cockpit **never restarts cmux for the user** — restarting
cmux disrupts live sessions. We write config + prompt; the user restarts.

### 4.4 Daemon-start re-check + recovery — `src/control/cockpitd.ts`

On daemon start, **when `daemonDirectCmux` is opt-in ON**, run
`ensureCmuxAutoConfig()` (idempotent). This:

- writes the config if a clean install never had it,
- recovers the §3.4 edge case (cmux not running at first write): because the
  check re-runs every daemon start, the next start re-probes and the value is
  already file-managed, so daemon-direct activates once cmux is (re)launched.

The re-check is **gated on the existing `daemonDirectCmux` flag** — a no-op when
the flag is OFF (relay default). It changes no `startCockpitd` signature; the
blast radius is LOW (verified via gitnexus_impact: 4 direct callers, 0 processes,
0 modules).

---

## 5. #332 Re-scope (documented here; delivery wiring may be a follow-up)

- **Relay = zero-setup default.** Works on any clean install with no cmux config
  changes. **Do NOT delete the relay.**
- **Daemon-direct = opt-in**, viable only once the non-cmux probe (§4.2) succeeds.
- **Hybrid selection**: the non-cmux probe is the gate. Daemon-direct is selected
  only when the probe returns `"reachable"`; otherwise cockpit stays on the relay.

This PR delivers the autoconfig primitives (config writer, probe, orchestrator,
CLI, gated daemon re-check). The full hybrid *delivery-path selection* in the
daemon (auto-switching relay ⇄ daemon-direct based on the probe) is the #332
follow-up.

---

## 6. Files

| File | Role |
|------|------|
| `src/lib/cmux-config.ts` | Comment-preserving JSONC merge (§4.1) |
| `src/lib/cmux-probe.ts` | Non-cmux orphan probe + classifier (§4.2) |
| `src/lib/cmux-autoconfig.ts` | Orchestrator: write → probe → one-time prompt (§4.3) |
| `src/commands/cmux.ts` | `cockpit cmux autoconfig` user-facing surface |
| `src/control/cockpitd.ts` | Gated daemon-start re-check / recovery (§4.4) |
| `docs/specs/2026-06-16-cmux-socket-auth-daemon-direct-design.md` | This doc |
