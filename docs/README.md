# Docs — claude-cockpit

Master index of the `docs/` directory. Every active document and archive subdirectory is linked here.

---

## Living docs

Current references that stay accurate as the project evolves.

| File | Purpose | Status |
|---|---|---|
| [../README.md](../README.md) | Project overview, install, commands, monorepo structure | Active |
| [../CLAUDE.md](../CLAUDE.md) | Claude Code agent instructions — GitNexus, repository layout, coding discipline | Active |
| [../AGENTS.md](../AGENTS.md) | Canonical multi-agent instructions (canonical per multi-agent direction) | Active |
| [architecture.html](architecture.html) | Detailed architecture reference — roles, daemon, driver seams, projection | Active (refreshed 2026-06-18) |
| [architecture.vi.html](architecture.vi.html) | Vietnamese companion to architecture.html | Active (refreshed 2026-06-18) |
| [diagrams/2026-06-18-cockpit-monorepo-architecture.html](diagrams/2026-06-18-cockpit-monorepo-architecture.html) | **Current** — 6-package monorepo architecture diagram (EN) | Active |
| [diagrams/2026-06-18-cockpit-monorepo-architecture.vi.html](diagrams/2026-06-18-cockpit-monorepo-architecture.vi.html) | Vietnamese companion to current architecture diagram | Active |
| [testing/crew-lifecycle-checklist.md](testing/crew-lifecycle-checklist.md) | Regression checklist — crew/daemon/relay/template changes | Active (living) |

---

## Active specs

Specs for features currently in progress or governing active systems.

| File | Purpose | Status |
|---|---|---|
| [specs/2026-04-24-multi-agent-direction.md](specs/2026-04-24-multi-agent-direction.md) | Multi-agent direction statement — Claude Code as reference impl, Codex/Gemini/Cursor roadmap | Active (governing) |
| [specs/2026-06-15-telegram-integration-design.md](specs/2026-06-15-telegram-integration-design.md) | Two-way Telegram integration design | Active — PR #316 open |
| [superpowers/specs/2026-06-18-docs-cleanup-and-refresh-design.md](superpowers/specs/2026-06-18-docs-cleanup-and-refresh-design.md) | Docs cleanup & refresh design (this task) | Active — in progress |

---

## Active plans

Implementation plans for work currently in progress.

| File | Purpose | Status |
|---|---|---|
| [plans/2026-06-15-telegram-integration.md](plans/2026-06-15-telegram-integration.md) | Telegram integration implementation plan | Active — PR #316 open |
| [superpowers/plans/2026-06-18-docs-cleanup-and-refresh.md](superpowers/plans/2026-06-18-docs-cleanup-and-refresh.md) | Docs cleanup & refresh plan (this task) | Active — in progress |

---

## Decisions

Architectural or strategic decisions with recorded rationale.

| File | Purpose | Status |
|---|---|---|
| [decisions/2026-06-05-issue-208-verdict.md](decisions/2026-06-05-issue-208-verdict.md) | Issue #208 verdict — service-health liveness layer scope decision | Decided |

---

## Research

Historical reference material. Dated snapshots — kept in place, not archived.

| File | Purpose |
|---|---|
| [research/2026-05-16-idle-detection-and-inter-agent-orchestration.md](research/2026-05-16-idle-detection-and-inter-agent-orchestration.md) | Idle detection + inter-agent orchestration research |
| [research/2026-05-17-cockpit-system-audit-and-orchestration-advice.md](research/2026-05-17-cockpit-system-audit-and-orchestration-advice.md) | System audit + orchestration advice (HTML/PDF also present) |
| [research/2026-05-19-orca-codex-wrapping-study.md](research/2026-05-19-orca-codex-wrapping-study.md) | Orca codex-wrapping study |
| [research/2026-05-19-orca-derived-cockpit-improvements.md](research/2026-05-19-orca-derived-cockpit-improvements.md) | Improvements derived from Orca study |
| [research/2026-05-19-orca-full-system-study.md](research/2026-05-19-orca-full-system-study.md) | Full Orca system study |
| [research/2026-05-21-phase2-start-handoff.md](research/2026-05-21-phase2-start-handoff.md) | Phase 2 interactive-codex start handoff |
| [research/2026-05-27-multi-session-orchestrator-notification-patterns.md](research/2026-05-27-multi-session-orchestrator-notification-patterns.md) | Multi-session orchestrator notification patterns (VI companion present) |
| [research/2026-05-27-tracking-codex-while-keeping-native-tui.md](research/2026-05-27-tracking-codex-while-keeping-native-tui.md) | Tracking codex while keeping native TUI (VI companion present) |
| [research/2026-06-16-cmux-agent-lifecycle-and-daemon-architecture.md](research/2026-06-16-cmux-agent-lifecycle-and-daemon-architecture.md) | cmux agent lifecycle + daemon architecture dossier |
| [research/2026-06-16-cmux-events-stream.md](research/2026-06-16-cmux-events-stream.md) | cmux native events stream research |
| [research/2026-06-16-cmux-workspace-groups-audit-C1.md](research/2026-06-16-cmux-workspace-groups-audit-C1.md) | cmux workspace groups audit (C1) |

Additional research files (HTML/PDF): `2026-05-17-cockpit-system-audit-and-orchestration-advice.html/.pdf`, `2026-05-19-cockpit-vs-orca-system-comparison.html`, `2026-05-19-orca-*.html`, `2026-05-27-*.vi.html`, `research/llm-wiki-research-report.pdf`.

---

## Reports

Debugging artifacts and compatibility audits. Kept as-is.

| File | Purpose |
|---|---|
| [reports/2026-06-15-cmux-compat-audit-0.62-0.64.md](reports/2026-06-15-cmux-compat-audit-0.62-0.64.md) | cmux 0.62→0.64 compatibility audit |
| [reports/2026-06-16-dbg-cmux-double-startup-and-enter-newline.md](reports/2026-06-16-dbg-cmux-double-startup-and-enter-newline.md) | Debug: cmux double-startup + enter-newline issue |
| `reports/258-parse-bug-fixture.txt`, `reports/268-overlay-fixture.txt`, `reports/294-ghost-placeholder-fixture.txt` | Bug reproduction fixtures |

---

## Archive

Shipped/superseded documents are moved here with status banners. Nothing is deleted — all content remains in-tree.

| Subdirectory | Contents |
|---|---|
| [specs/archive/](specs/archive/) | 26 shipped/superseded specs (plugin system, multi-agent, control-plane, etc.) |
| [plans/archive/](plans/archive/) | 7 shipped implementation plans (control-plane, codex, mailbox, service-health, etc.) |
| [superpowers/specs/archive/](superpowers/specs/archive/) | 11 shipped superpowers specs (reorg steps 1–7, side-sessions, daemon-direct, etc.) |
| [superpowers/plans/archive/](superpowers/plans/archive/) | 11 shipped superpowers plans (reorg steps 2–7, phase-b, side-sessions, etc.) |
| [diagrams/archive/](diagrams/archive/) | 6 pre-reorg architecture diagrams with ⛔ superseded banners |
| [reports/archive/](reports/archive/) | 3 pre-reorg report HTMLs (cockpitd structure, daemon flow, relation graphs) |
