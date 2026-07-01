# README rewrite: user-journey design

## Reader

An OSS stranger evaluating Squadrant cold. They decide in ~30 seconds whether
it's for them. Today's README opens with jargon ("Multi-project orchestration
layer for coding agents") then dumps a 40-row command table, config schema,
and eight architecture sections before any "why would I want this" moment.
This rewrite fixes that by restructuring into a journey: pitch → hands-on
quickstart → reference.

## Core framing (used throughout)

**"You're the manager, agents are your team."**

You → **Captains** (one per project, plan & delegate) → **Crews** (write the
code). One person operating like an engineering org. This replaces the current
lead framing ("Multi-project orchestration layer for coding agents") as the
first thing a reader sees; the multi-agent direction note moves down/folds in
rather than being the second thing read.

## Three-file structure

### 1. `README.md` — the pitch (evaluator-focused, lean)

Order:
1. Title + reframed one-liner (concrete, warm, not buzzwordy)
2. Mental model hook — ASCII org chart: You → Captains → Crews, one line each.
   Multi-agent direction note folds in here or moves lower, not position #2.
3. Why you'd want it — 3–4 bullets (parallel projects, delegate not
   micromanage, agents signal you, drive from phone)
4. What it feels like — one concrete trace (launch → captain → "build X" →
   crew spawns → CREW DONE) → link to QUICKSTART
5. Install (minimal) — `npm i -g squadrant` / `init` / `doctor` only, link
   QUICKSTART for guided path + from-source; keep "formerly claude-cockpit"
   as a small aside
6. Supported agents table (kept — real differentiator)
7. Where to go next — links to QUICKSTART, architecture diagram,
   docs/reference.md, Contributing
8. Inspirations + License (preserved verbatim — all credits kept)

### 2. `QUICKSTART.md` (new) — hands-on first run

- Prerequisites (moved from README: Claude Code/cmux/Obsidian/Node, Required
  Integrations, Obsidian Plugins)
- Install & init (full: npm + from-source, init, doctor)
- Your first captain (`squadrant launch <project>`)
- Your first crew (spawn/send/read/close flow, CREW DONE)
- Drive it from your phone (optional, condensed Telegram happy path, link to
  reference.md for full security model/tuning)
- Other handy things (optional): command --task briefing, dashboard --pane,
  status
- Troubleshooting: doctor, heal

### 3. `docs/reference.md` (new) — heavy reference, moved verbatim

- Full Commands table (~40 rows)
- Monorepo structure (packages table, DAG, build outputs)
- Architecture (Roles, Model Routing, Runtime/Workspace/Notifier Abstraction,
  Crew Spawn, Effort Dial, Crew Lifecycle & Delivery, Projection, Obsidian
  Vaults, Knowledge System, Session Continuity)
- Telegram (Two-Way) full deep-dive incl. security model (#321), notification
  tuning, remote wake
- Config — full JSON schema + field explanations

Short intro line + table of contents at top. No content trimmed — this is a
move, not a rewrite of the underlying facts.

### 4. Link fixes

Repoint anchors that pointed into README's now-moved sections:
- `AGENTS.md` — Telegram reference link → `docs/reference.md#telegram-two-way-opt-in`
- `docs/README.md` — index row for README.md, add rows for QUICKSTART.md and
  docs/reference.md

## Constraints

- Docs restructure only — no source code changes, no invented content.
- Every fact/command/credit from current README preserved somewhere across
  the three files.
- Match existing markdown style (tables, anchors, badge-free plain headers).

## Branch & done

Branch `docs/readme-user-journey`, PR to `develop`.
