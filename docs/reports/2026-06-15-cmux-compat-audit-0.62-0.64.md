# cmux Compatibility & Opportunity Audit — 0.62.0 → 0.64.16

**Date:** 2026-06-15
**cmux window audited:** 0.62.0 (2026-03-12) → 0.64.16 (2026-06-15) — 24 releases, ~3 months
**Sources:** `manaflow-ai/cmux` `CHANGELOG.md` + `docs/cli-contract.md` (raw from `main`)
**Trigger:** user updated cmux to 0.64.16; deprecation spam + broken `--fresh` surfaced. Cockpit's code last referenced cmux ~0.62.2, so this audit covers the drift since then.
**Method:** cross-referenced every cmux invocation / output-assumption across cockpit's integration surface — `src/runtimes/cmux.ts`, `src/notifiers/cmux.ts`, `src/commands/launch.ts`, `src/commands/notify-relay.ts`, `src/control/interactive/pane-classifier.ts`, `src/control/liveness.ts`, `src/control/cockpitd.ts`.

---

## Executive summary

- **No hard breaks** beyond the two already fixed in-flight (workspace-verb migration + pinned-workspace close). cmux's contract keeps the text output cockpit pins to stable.
- **Category A (must-adapt): 4 findings** — 1 correctness regression risk (A1 focus-restore), 1 already-folded defensive item (A4 id-format), 2 cosmetic/latent (A2, A3).
- **Category B (simplify integration): 4 findings** — biggest lever is **B1 `cmux events` JSON stream**, which can retire the daemon's relay-proxy cmux-blindness workaround. **B3 focus-neutral spawn is the same fix as A1.**
- **Category C (adopt new capability): 5 findings** — workspace groups, agent hibernation, per-workspace env lead.
- **Single most important architecture finding:** `cmux events` (reconnectable JSON event bus) — replaces screen-scraping for liveness/focus/surface enumeration.

### Disposition (2026-06-15 decisions)
| Item | Disposition |
|------|-------------|
| Verb migration + `CMUX_QUIET=1` + pinned-close unpin | **In-flight crew** `cmux-compat` (branch `fix/cmux-0.64-compat`) |
| A4 `--id-format refs` hardening | **Folded into in-flight crew** |
| A1 + B3 (focus-neutral spawn) | **Pre-release crew — gates v1.0.0** |
| A2 (OSC sanitizer) | Confirm no-op in pre-release crew |
| A3, B1, B2, B4, C1–C5 | **This audit + single tracking GH issue** → carve sub-issues later |

---

## Category A — Behavioral changes cockpit must adapt to

### A1. Focus-restore `move-surface --index --focus` dance is now fragile — **DEGRADES (correctness)**
- **cmux:** 0.64.16 "Freeform 2D canvas layout for workspace panes" (#5987) + "Stagger restored terminal surface spawns" (#6149).
- **cockpit:** `src/runtimes/cmux.ts:331-360` (`newPane`), `:402-425` (`spawnInjector`), `parseSurfaceOrder` `:60-69`. Records the `[selected]` surface's **array index** from `cmux tree`, then `move-surface --surface <prior> --index <priorIndex> --focus true`.
- **Why:** the new canvas layout + staggered restore weaken the "tree order == linear tab-strip index" invariant. During staggered restore the tree can be transiently incomplete → `priorIndex` points at the wrong surface; under canvas layout "index" is no longer a 1-D strip position. Already best-effort (`try/catch`), so failure mode is **silent loss of focus restoration** = regression of the #295 focus-steal (captain keystrokes land in the fresh crew's launch line).
- **Fix:** move off index-based refocus → focus-neutral spawn (see **B3** — same work). Gates v1.0.0.

### A2. `cmux send` OSC fix — **COSMETIC (no change)**
- **cmux:** 0.64.14 "Fix OSC control sequences printed as literal text when sent via `cmux send`" (#5509).
- **cockpit:** `sanitizeForCmuxSend` `cmux.ts:75-81` only collapses `\n\r\t` (newline→Enter protection), never relied on OSC passthrough. No conflict. Confirm + move on.

### A3. `read-screen` chrome-scraping is version-drifting — **DEGRADES (latent)**
- **cmux:** TUI-chrome-adjacent changes — 0.64.0 "Auto-hide terminal scroll bar on alt-screen", 0.64.13 "Anchor textbox autocomplete to cursor", 0.64.15 React/Solid agent-session panels (#4429).
- **cockpit:** `CC_INITIALIZED_RE`/`CC_WORKING_RE` `cmux.ts:200,214`; `parseDraftFromScreen` `:97-161`; `classifyPaneTail` `pane-classifier.ts:93-113` — all pinned to specific glyphs (`⏵⏵`, `❯`, `─{10,}` HR, `▌█`) and English spinner phrases.
- **Why:** every cmux/CC chrome change is a silent breakage risk. This is the structural fragility the whole report flags.
- **Fix:** no forced change now; durable answer is **B4** (structured agent state), which cmux has not yet exposed over the socket. **Tracked in the GH issue.**

### A4. `--id-format` default assumption — **COSMETIC (folded into in-flight crew)**
- **cmux:** global `--id-format refs|uuids|both`.
- **cockpit:** every parser assumes `workspace:N`/`surface:N` ref form — `parseList` `:45`, `parseSurfaceOrder` `:64`, `listSurfaces` `:491`, spawn id-extraction `:261`. If the default ever changes, all silently return empty.
- **Fix:** pass `--id-format refs` explicitly on read commands (`workspace list`, `tree`). **Folded into crew `cmux-compat`.**

---

## Category B — New cmux APIs that could reduce/simplify cockpit integration

### B1. ⭐ Reconnectable JSON event stream (`cmux events` / `events.jsonl`)
- **cmux:** CLI contract §Events; `capabilities` advertises `events.stream`; `~/.cmuxterm/events.jsonl` emits surface selection/focus/creation/closure + workspace selection; cursor-file + `--after-seq` resume. 0.64.10 reorder events; 0.64.15 event-stream allocation fix (#5664) → load-bearing, maintained.
- **Replaces:** the surface-liveness reaper's per-sweep `tree` scrape (`crew-pane-reader.ts`), and **the entire relay-proxy cmux-blindness workaround** (`relay-proxy-poll`/`result` in `notify-relay.ts:331-365`, `cockpitd.ts:208-217,590-608`) that exists only because the launchd daemon can't poll cmux. A daemon-side subscriber gives authoritative surface-create/close/select events with built-in resume.
- **Value:** HIGH (biggest architectural simplification). Prototype a daemon `cmux events --reconnect --cursor-file … --category surface,workspace` consumer; map `surface.closed`→reaper, `surface.selected`→focus tracking. Keep scrape path as fallback during migration.

### B2. `--json` output on `tree`/list
- **cmux:** global `--json`; 0.64.16 "Expose each workspace's custom title to the control socket" (#6013).
- **Replaces:** the four hand-rolled regex parsers (`parseList`, `parseSurfaceOrder`, `listSurfaces`, stdout id-extraction). Custom titles become first-class instead of quoted-substring matching (`send` routing `:293-305`).
- **Value:** MEDIUM-HIGH. Eliminates ~5 brittle regexes + the A4 risk in one move.

### B3. Focus-neutral spawn (`split-off`, `workspace.create --layout`)
- **cmux:** 0.64.0 "Focus-neutral split-off layout command" (#3484) + "`--layout` on `workspace.create`" (#2916); contract: `split-off` "Move a surface into a new split without changing focus by default".
- **Replaces:** the snapshot-index-then-`move-surface --focus` logic in `newPane`/`spawnInjector` (`cmux.ts:331-360`, `402-425`) — i.e. **the A1 fix.** `split-off` exists specifically to not steal focus, which is the #295 problem hand-rolled around.
- **Value:** MEDIUM-HIGH. **Bundled with A1, gates v1.0.0.**

### B4. Hook-less live-agent / fork detection + agent-session panels
- **cmux:** 0.64.16 "Detect live claude/codex processes so hook-less agent sessions stay fork-able" (#6133); 0.64.15 agent-session panels (#4429); 0.64.3 live status driving the tab status bar (#5235).
- **Replaces (eventually):** the CC-chrome heuristics (`classifyStartupSurface`, `CC_WORKING_RE`/`CC_INITIALIZED_RE`, parts of `classifyPaneTail`) — cmux now tracks agent run-state internally.
- **Value:** MEDIUM (watch-and-adopt; not yet socket-exposed). Long-term answer to A3. **Tracked.**

> The #302 buffer-liveness backspace probe in `sendToSurface` (`cmux.ts:429-479`) protects the captain's *own* draft and has **no cmux-side equivalent** in this window — keep it.

---

## Category C — New cmux features worth integrating (ranked)

### C1. Workspace groups CLI (`cmux workspace-group`) — HIGH
- **cmux:** 0.64.11 (#5018) create/remove/set-color/set-icon/move/focus groups + per-group new-workspace placement; 0.64.15 group commands in cloud relay (#5856).
- **For cockpit:** maps 1:1 onto captain + N crews per project. Replaces ad-hoc `pinToTop` (`cmux.ts:276-285`) + `🔧 project:name` title convention with a first-class colored/iconed container; per-group placement lands new crews in the right group automatically. Aligns with the "sibling projects aware of each other" goal.

### C2. Agent Hibernation — HIGH (targets the RAM-flood pain)
- **cmux:** 0.64.11 (#4165) pauses idle agent sessions, restore-on-demand; 0.64.14 5s idle default (#5449); `agent-hibernation <on|off>`.
- **For cockpit:** directly addresses the documented RAM-flood / orphaned-headless-session theme and the 24h idle crew budget (`liveness.ts:48-49`). Enable in launch defaults; **verify a hibernated crew reads as "alive" to the reaper, not "gone".**

### C3. Per-workspace environment variables (`workspace env` / `--env` / `--env-file`) — MEDIUM-HIGH
- **cmux:** 0.64.16 (#6116) per-workspace env inherited by every shell, re-applied on restore, protected `CMUX_*` keys.
- **For cockpit:** replaces the `envPrefix` string concatenation (`crew.ts:399,449`); survives restore; cleaner shell-safety (#118). Could finally give **codex crews a stable `COCKPIT_CREW_TASK_ID`** (the known codex-signal gap).

### C4. Detachable SSH PTY daemon + `workspace reconnect/disconnect` — MEDIUM (future remote crews)
- **cmux:** 0.64.11 (#4807) detachable SSH PTY; 0.64.13 SSH agent forwarding (#5301).
- **For cockpit:** dropped connection wouldn't kill an in-flight remote crew turn. Roadmap note for remote/cloud crews; no action now.

### C5. `--window` routing — MEDIUM-LOW
- **cmux:** 0.64.8 (#4211) `--window` for window-scoped commands.
- **For cockpit:** scope `list`/`tree` to the captain's window to avoid multi-window collisions when resolving a captain by name. Low priority until a collision is reported.

---

## Explicitly NOT a concern (so the release doesn't chase them)
- **Notification CLI** (0.64.5/0.64.11 panel parity, redesign, dismiss/mark-read/jump-to-unread): cockpit uses its own mailbox + notify-relay; never calls `cmux notify`/`set-status`/`list-notifications`. Optional only.
- **Browser automation suite** (0.64.13–16): cockpit doesn't drive cmux's browser.
- **GUI-only** (iOS app, themes, sidebar font, markdown/diff viewers, minimap): no CLI/socket dependency — except the freeform **canvas** (A1).
