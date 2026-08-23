# Docs — Squadrant

Master index of the `docs/` directory. Every active document is linked here. Shipped/superseded planning docs and historical research are **archived to the hub vault** (zipped, out of the repo — see [Archive](#archive)); they remain recoverable from git history too.

---

## Living docs

Current references that stay accurate as the project evolves.

| File | Purpose | Status |
|---|---|---|
| [../README.md](../README.md) | Pitch — mental model, why you'd want it, install | Active |
| [../QUICKSTART.md](../QUICKSTART.md) | Hands-on first run — install, first captain, first crew, Telegram | Active |
| [reference.md](reference.md) | Full command table, monorepo structure, architecture, Telegram, config schema | Active |
| [../CLAUDE.md](../CLAUDE.md) | Claude Code agent instructions — repository layout, coding discipline | Active |
| [../AGENTS.md](../AGENTS.md) | Canonical multi-agent instructions (canonical per multi-agent direction) | Active |
| [architecture.html](architecture.html) | Detailed architecture reference — roles, daemon, driver seams, projection | Active (refreshed 2026-06-18) |
| [architecture.vi.html](architecture.vi.html) | Vietnamese companion to architecture.html | Active (refreshed 2026-06-18) |
| [diagrams/2026-08-22-squadrant-architecture.html](diagrams/2026-08-22-squadrant-architecture.html) | **Current** — 6-package DAG + daemon + 3 driver seams + lifecycle sources + control/captain channel (#667) | Active |
| [diagrams/2026-06-18-squadrant-monorepo-architecture.html](diagrams/2026-06-18-squadrant-monorepo-architecture.html) | Superseded by the 2026-08-22 diagram — package/DAG layout only, predates #667. Kept for history. | Superseded |
| [diagrams/2026-06-18-squadrant-monorepo-architecture.vi.html](diagrams/2026-06-18-squadrant-monorepo-architecture.vi.html) | Vietnamese companion to the 2026-06-18 diagram | Superseded |
| [diagrams/2026-06-23-telegram-daemon-architecture.html](diagrams/2026-06-23-telegram-daemon-architecture.html) | Telegram bridge ⇄ daemon architecture | Active |
| [diagrams/2026-07-01-lifecycle-and-delivery-flow.html](diagrams/2026-07-01-lifecycle-and-delivery-flow.html) | Crew lifecycle & delivery flow (pre-#667 semantic-heartbeat model) | Active |
| [diagrams/2026-07-24-cmux-session-tracking-swimlane.html](diagrams/2026-07-24-cmux-session-tracking-swimlane.html) | cmux session tracking swimlane | Active |
| [diagrams/2026-07-24-cmux-session-tracking-swimlane-vi.html](diagrams/2026-07-24-cmux-session-tracking-swimlane-vi.html) | Vietnamese companion | Active |
| [diagrams/2026-08-13-agent-control-channel.html](diagrams/2026-08-13-agent-control-channel.html) | Agent control channel design (#667) — claude/opencode native APIs as ground truth | Active |
| [testing/crew-lifecycle-checklist.md](testing/crew-lifecycle-checklist.md) | Regression checklist — crew/daemon/delivery/template changes | Active (living) |

---

## Active specs

Specs for features currently in progress or governing active systems.

| File | Purpose | Status |
|---|---|---|
| [specs/2026-04-24-multi-agent-direction.md](specs/2026-04-24-multi-agent-direction.md) | Multi-agent direction statement — Claude Code as reference impl, Codex/Gemini/Cursor roadmap | Active (governing) |
| [specs/2026-06-15-telegram-integration-design.md](specs/2026-06-15-telegram-integration-design.md) | Two-way Telegram integration design | Superseded (see in-file note) — Telegram v1 shipped 0.10.0+ |
| [specs/2026-06-15-crew-effort-design.md](specs/2026-06-15-crew-effort-design.md) | Crew effort dial (tokenomics) design | Shipped — #317/#381 |
| [specs/2026-06-23-telegram-topic-clutter-design.md](specs/2026-06-23-telegram-topic-clutter-design.md) | Per-project Telegram notification tiers | Shipped — #407 |
| [specs/2026-06-24-codebase-structure-refactor.md](specs/2026-06-24-codebase-structure-refactor.md) | Monorepo reorg into 6 packages | Shipped — reorg complete |
| [specs/2026-06-26-lifecycle-source-port-design.md](specs/2026-06-26-lifecycle-source-port-design.md) | `LifecycleSource` abstraction (CmuxStore + NativeHook + CodexAppServer) | Shipped — #333 Phase 1 deployed |
| [specs/2026-07-02-cross-project-ping-dispatch-design.md](specs/2026-07-02-cross-project-ping-dispatch-design.md) | `squadrant ping`/`dispatch` cross-project delivery | Shipped |
| [specs/2026-07-07-captain-liveness-redesign.md](specs/2026-07-07-captain-liveness-redesign.md) | Captain liveness — ground-truth `LivenessRegistry` | Shipped — v0.15.0 |
| [specs/2026-07-07-captain-liveness-redesign-plan.md](specs/2026-07-07-captain-liveness-redesign-plan.md) | Implementation plan for the above | Shipped — v0.15.0 |
| [specs/2026-07-09-draft-clobber-mailbox-routing.md](specs/2026-07-09-draft-clobber-mailbox-routing.md) | Draft-clobber mailbox routing fix | Approved — not implemented |
| [specs/2026-07-23-animated-system-graph-skill.md](specs/2026-07-23-animated-system-graph-skill.md) | `explainer-reel` animated system-graph skill | Proposed — scoping only (#598) |
| [specs/2026-07-28-captain-context-budget.md](specs/2026-07-28-captain-context-budget.md) | Captain per-turn context budget — read-only analysis | Reference (research) |
| [specs/2026-07-29-opencode-session-resume-spike.md](specs/2026-07-29-opencode-session-resume-spike.md) | opencode cross-day session resume spike | Answered — YES |
| [specs/2026-07-29-persisted-work-tracking.md](specs/2026-07-29-persisted-work-tracking.md) | Persisted work-tracking store (#630) | Approved direction — not started |
| [specs/2026-07-29-provider-independence-two-phase-plan.md](specs/2026-07-29-provider-independence-two-phase-plan.md) | Provider-independence two-phase plan | Approved direction — not started |
| [specs/2026-08-06-crew-operator-takeover.md](specs/2026-08-06-crew-operator-takeover.md) | Crew operator takeover (`/takeover`, `/handback`) | Shipped — #649, v0.18.0 |
| [specs/2026-08-13-agent-control-channel-design.md](specs/2026-08-13-agent-control-channel-design.md) | Agent control channel — native agent APIs as ground truth | Live — #667, `captainChannel=on` for claude (cutover 2026-08-20); opencode still shadow/off |
| [superpowers/specs/2026-06-18-docs-cleanup-and-refresh-design.md](superpowers/specs/2026-06-18-docs-cleanup-and-refresh-design.md) | Docs cleanup & refresh design | Shipped — superseded by this 2026-08-22 refresh pass |

---

## Active plans

Implementation plans for work currently in progress.

| File | Purpose | Status |
|---|---|---|
| [plans/2026-06-15-telegram-integration.md](plans/2026-06-15-telegram-integration.md) | Telegram integration implementation plan | Shipped — Telegram v1 (v0.10.0+) |
| [superpowers/plans/2026-06-18-docs-cleanup-and-refresh.md](superpowers/plans/2026-06-18-docs-cleanup-and-refresh.md) | Docs cleanup & refresh plan | Shipped — superseded by this 2026-08-22 refresh pass |

---

## Decisions

Architectural or strategic decisions with recorded rationale.

| File | Purpose | Status |
|---|---|---|
| [decisions/2026-06-05-issue-208-verdict.md](decisions/2026-06-05-issue-208-verdict.md) | Issue #208 verdict — service-health liveness layer scope decision | Decided |

---

## Reports (active)

Debugging artifacts and compatibility audits still referenced.

| File | Purpose |
|---|---|
| [reports/2026-06-15-cmux-compat-audit-0.62-0.64.md](reports/2026-06-15-cmux-compat-audit-0.62-0.64.md) | cmux 0.62→0.64 compatibility audit |
| [reports/2026-06-16-dbg-cmux-double-startup-and-enter-newline.md](reports/2026-06-16-dbg-cmux-double-startup-and-enter-newline.md) | Debug: cmux double-startup + enter-newline issue |
| `reports/258-parse-bug-fixture.txt`, `reports/268-overlay-fixture.txt`, `reports/294-ghost-placeholder-fixture.txt` | Bug reproduction fixtures |

---

## Archive

Shipped/superseded planning docs, pre-reorg diagrams/reports, and historical research are bundled into a single zip in the **hub vault**, out of the code repo (the working tree stays active-docs-only). Nothing is lost — the same files also remain in git history.

- **Location:** `~/squadrant-hub/spokes/squadrant/archive/squadrant-docs-archive-2026-06-18.zip`
- **Contains (~85 docs):** shipped `specs/` + `plans/` + `superpowers/{specs,plans}/` (incl. reorg steps 1–7, plugin system, multi-agent, control-plane, side-sessions, daemon-direct, …), the 6 pre-reorg architecture diagrams, 3 pre-reorg report HTMLs, and the full historical `research/` set (Orca studies, cmux lifecycle dossiers, notification-pattern research, …).
- **Recover a single file from git instead:** `git log --all -- docs/<path>` then `git checkout <sha> -- docs/<path>`.
