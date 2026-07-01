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
| [../CLAUDE.md](../CLAUDE.md) | Claude Code agent instructions — GitNexus, repository layout, coding discipline | Active |
| [../AGENTS.md](../AGENTS.md) | Canonical multi-agent instructions (canonical per multi-agent direction) | Active |
| [architecture.html](architecture.html) | Detailed architecture reference — roles, daemon, driver seams, projection | Active (refreshed 2026-06-18) |
| [architecture.vi.html](architecture.vi.html) | Vietnamese companion to architecture.html | Active (refreshed 2026-06-18) |
| [diagrams/2026-06-18-squadrant-monorepo-architecture.html](diagrams/2026-06-18-squadrant-monorepo-architecture.html) | **Current** — 6-package monorepo architecture diagram (EN) | Active |
| [diagrams/2026-06-18-squadrant-monorepo-architecture.vi.html](diagrams/2026-06-18-squadrant-monorepo-architecture.vi.html) | Vietnamese companion to current architecture diagram | Active |
| [testing/crew-lifecycle-checklist.md](testing/crew-lifecycle-checklist.md) | Regression checklist — crew/daemon/delivery/template changes | Active (living) |

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
