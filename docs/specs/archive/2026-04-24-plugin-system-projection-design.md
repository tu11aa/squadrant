# Plugin/Extension System — Projection: Cross-Agent Config Sync

> **✅ Shipped** (PR #36, 2026-04-24). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-04-24
**Status:** Draft — design only, implementation to follow
**Issue:** [#31](https://github.com/tu11aa/claude-cockpit/issues/31)
**Depends on:** Plugin phases 1-4 (runtime, workspace, tracker, notifier — all merged)
**Related:** [#34](https://github.com/tu11aa/claude-cockpit/issues/34) MCP sync (follow-up), [#35](https://github.com/tu11aa/claude-cockpit/issues/35) role identity (follow-up), [`docs/specs/2026-04-24-multi-agent-direction.md`](./2026-04-24-multi-agent-direction.md)

## Problem

When opening a cockpit-managed project in Codex, Cursor, or Gemini CLI, the agent is missing:

- Cockpit's coding disciplines (Karpathy principles, captain/crew conventions)
- Instructions from the project's own `AGENTS.md` (not read — agent looks at `.cursor/rules/` or `GEMINI.md` instead)
- Skill content packaged for Claude's Skill tool

Each agent has its own canonical instruction file at a different path. Today the user maintains parallel configs by hand or just loses context when switching.

## Goal

Ship `cockpit projection` — a command that emits cockpit's canonical content to each supported agent's expected path. Mirrors the driver+registry+CLI pattern used by runtime/workspace/tracker/notifier phases.

V1 covers **instructions + skills** (option B from brainstorm). V1 targets **Cursor, Codex CLI, Gemini CLI**.

## Non-goals

- **MCP config sync** — deferred to [#34](https://github.com/tu11aa/claude-cockpit/issues/34); delegate to Conductor or mcp-linker when shipped
- **Role identity for non-Claude agents** (captain/crew as first-class in Codex/Cursor) — deferred to [#35](https://github.com/tu11aa/claude-cockpit/issues/35)
- **Aider, Windsurf, OpenCode, Warp targets** — add as follow-up PRs once V1 scaffold is in
- **AGENTS.md format validation** — assume user's `AGENTS.md` is well-formed markdown; don't lint
- **Reverse projection** (reading `.cursor/rules/*.mdc` back into `AGENTS.md`) — one-way only
- **Strict typing of emitter config** — shipping loose, same pattern as prior phases

## Architecture: Projection Emitter (mirrors Runtime + Workspace + Tracker + Notifier)

```
cockpit core
  └── src/projection/
        ├── types.ts         ← ProjectionEmitter interface
        ├── cursor.ts        ← Cursor emitter (.cursor/rules/*.mdc)
        ├── codex.ts         ← Codex CLI emitter (AGENTS.md)
        ├── gemini.ts        ← Gemini CLI emitter (GEMINI.md)
        ├── registry.ts      ← ProjectionRegistry — target name → emitter
        ├── marker.ts        ← Marker-merge helper shared by all emitters
        ├── index.ts         ← re-exports
        └── __tests__/
  └── src/lib/canonical-source.ts   ← Reads AGENTS.md + plugin/skills/ into normalized doc
  └── src/commands/projection.ts    ← CLI surface
```

## Two-Tier Projection Model

Each supported agent has both user-level (applies to all work) and project-level (one repo) config. Cockpit's content splits along the same line.

| Tier | Source | Destination | Handling |
|---|---|---|---|
| User-level | `plugin/skills/*/SKILL.md` in cockpit repo (Karpathy, captain-ops, wiki-ops, etc.) | `~/.cursor/rules/cockpit-global.mdc` | Dedicated — overwrite |
| User-level | " | `~/.codex/AGENTS.md` | Shared — marker-merge |
| User-level | " | `~/.gemini/GEMINI.md` | Shared — marker-merge |
| User-level | " | `~/.claude/CLAUDE.md` | Shared — marker-merge |
| Project-level | `{project.path}/AGENTS.md` (if present) | `{project.path}/CLAUDE.md` | Shared — marker-merge |
| Project-level | " | `{project.path}/.cursor/rules/cockpit.mdc` | Dedicated — overwrite |
| Project-level | " | `{project.path}/GEMINI.md` | Shared — marker-merge |

**Key property:** Project-level projection never injects cockpit-global content into the project. Brove's `CLAUDE.md` contains only brove's `AGENTS.md` content — zero Karpathy/captain-ops leakage into brove's repo.

## 1. ProjectionEmitter Interface

```typescript
// src/projection/types.ts
export interface ProjectionSource {
  instructions: string;  // AGENTS.md contents
  skills: Array<{ name: string; description: string; content: string }>;
}

export interface ProjectionDestination {
  path: string;            // absolute path to write
  shared: boolean;         // true → marker-merge; false → overwrite
  format: "markdown" | "mdc";
}

export interface ProjectionEmitResult {
  written: boolean;        // false = no-op (e.g., project has no AGENTS.md)
  path: string;
  bytesWritten: number;
  diff?: string;           // populated when called via projection diff
}

export interface ProjectionEmitter {
  name: string;            // "cursor", "codex", "gemini"

  destinations(scope: "user" | "project", projectRoot?: string): ProjectionDestination[];
  emit(source: ProjectionSource, dest: ProjectionDestination, opts?: { dryRun?: boolean }): Promise<ProjectionEmitResult>;
}

export type ProjectionEmitterFactory = () => ProjectionEmitter;
```

### Contract notes

- **`destinations()` returns one or more paths per target.** Cursor emits to a single `.mdc` file; some future targets may emit multiple files (e.g., separate `user-rules.mdc` and `project-rules.mdc`).
- **`emit()` is idempotent.** Running twice with the same source must produce byte-identical output. Marker-merge preserves surrounding content.
- **Dry-run returns populated `diff` field**, does not write.

## 2. Marker-Merge Helper

```typescript
// src/projection/marker.ts
const MARKER_START = "<!-- cockpit:start -->";
const MARKER_END = "<!-- cockpit:end -->";

export function mergeWithMarkers(existing: string | null, generated: string): string {
  // If existing is null → return marker-wrapped generated
  // If existing has markers → replace content between markers
  // If existing has no markers → append marker-wrapped block
  // If markers are corrupted (start without end) → throw with repair instruction
}
```

Pattern matches what GitNexus already uses in `AGENTS.md` and `CLAUDE.md` — mental model is familiar.

## 3. Registry

```typescript
// src/projection/registry.ts
export class ProjectionRegistry {
  constructor(private factories: Record<string, ProjectionEmitterFactory>) {}

  get(name: string): ProjectionEmitter { /* throws on unknown */ }

  list(): string[] { return Object.keys(this.factories); }
}
```

No per-project override — projection targets are a global config choice.

## 4. Canonical Source Reader

```typescript
// src/lib/canonical-source.ts
export async function readUserLevelSource(workspace: WorkspaceDriver): Promise<ProjectionSource> {
  // Inline every plugin/skills/*/SKILL.md (Karpathy, captain-ops, wiki-ops, etc.) with ## headers per skill.
  // DOES NOT include cockpit's own AGENTS.md — that file is cockpit-repo-specific (gitnexus rules,
  // project-direction notes for cockpit itself) and would pollute user-global config for every project.
  // User-global content is exactly the skill content, nothing else.
}

export async function readProjectLevelSource(projectPath: string): Promise<ProjectionSource | null> {
  // Read {projectPath}/AGENTS.md — return null if not present
  // Inline {projectPath}/plugin/skills/*/SKILL.md if the project has them (rare, but supported)
}
```

Uses the existing workspace driver for I/O (no direct `fs` calls — keeps the abstraction consistent with prior phases).

## 5. Config

```jsonc
// ~/.config/cockpit/config.json — additions (all optional)
{
  "projection": {
    "targets": ["cursor", "codex", "gemini"]  // emitters run by default; omit → run all registered
  }
}
```

No per-project projection override. Projects opt in by having an `AGENTS.md` at their root; they opt out by not having one.

## 6. CLI Subcommand

```
cockpit projection emit [options]
  --scope <user|project>        emit only one tier (default: both, auto-detected)
  --project <name>              emit for a specific managed project (implies --scope project)
  --target <name>               emit only one target (cursor, codex, gemini)
  --all                         emit user-level + all managed projects

cockpit projection diff [options]   same flags as emit — dry-run, prints unified diff

cockpit projection list            show registered targets, their destinations per scope
```

Default behavior of bare `cockpit projection emit`:
- If cwd is a managed project → emit project-level for that project, skip user-level
- If cwd is cockpit's own repo → emit user-level, skip project-level (user-level source is `plugin/skills/` — cockpit's own `AGENTS.md` is cockpit-specific and doesn't get projected globally)
- Otherwise → emit user-level only

Exit 0 on success; 1 on failure; 2 on marker corruption that needs manual repair.

## 7. Refactor / Integration Surface

| File | Change |
|---|---|
| `src/commands/doctor.ts` | Probe each configured projection target (destination directory writable, existing files have valid markers) |
| `README.md` | Add `cockpit projection` rows to commands table; update Supported Agents table |
| `src/config.ts` | Add optional `projection: { targets?: string[] }` |
| `src/commands/index.ts` | Wire up new `projection` subcommand |

Other call-sites are untouched — projection is additive.

## 8. Testing

Mirror prior phases:

- **Unit tests per emitter** — known `ProjectionSource` in, expected output string out. Cover: fresh write, marker update on shared file, overwrite on dedicated file, dry-run.
- **MarkerMerge tests** — fresh file, existing with markers, existing without markers, corrupted markers.
- **`CanonicalSource` tests** — in-memory workspace driver with fixture skills, verify normalized structure.
- **`ProjectionRegistry` tests** — default registration, unknown name throws, list returns registered names.
- **CLI integration** — write to tmp dir, verify file contents + exit codes for `emit`, `diff`, `list`.
- **Integration smoke** — gated on `SKIP_INTEGRATION=1`: emit to a real tmp project dir, shell out to `npx @cursor/validate` or equivalent if available to validate output format.

## 9. Rollout

1. Land this spec and implementation plan
2. Scaffold `src/projection/` with types + registry + marker helper
3. Implement three emitters (Cursor, Codex, Gemini)
4. Add `CanonicalSource` reader
5. Add `cockpit projection` CLI
6. Add doctor probe
7. Document in README
8. Run emission against the user's real environment (cockpit repo + brove + pact-network) end-to-end
9. Ship as single PR

## 10. Relationship to Other Work

- **Completes the multi-agent direction** [`docs/specs/2026-04-24-multi-agent-direction.md`](./2026-04-24-multi-agent-direction.md) — gives agents the instruction + skill parity that was missing.
- **Builds on** plugin phases 1-4 — same driver+registry+CLI pattern, reuses workspace driver for I/O.
- **Unblocks** [#34](https://github.com/tu11aa/claude-cockpit/issues/34) MCP sync (independent but compositional) and [#35](https://github.com/tu11aa/claude-cockpit/issues/35) role identity (requires projection scaffold to exist first).
- **Does not block** anything on the current roadmap — additive.

## 11. Risks

- **Agent format drift.** Cursor's `.mdc` frontmatter schema or Codex's `AGENTS.md` expectations may change. Mitigation: emitters are small and isolated; updating one is ~20 lines.
- **Marker collision.** Using `<!-- cockpit:start -->` alongside gitnexus's `<!-- gitnexus:start -->` in the same file. Mitigation: markers are distinct; emitters only touch their own marker block.
- **Large managed projects** (brove with many files) — emission should be fast because it only reads `AGENTS.md` + a few skill files, not the project source.
