# Rules KB: prior art (research, 2026-10-07)

Input for the brainstorm on `docs/specs/2026-10-07-rules-kb-design.md`. Three parallel research passes covered self-learning agents, harness rule systems, and org-scale extraction and governance. Items marked [UNVERIFIED] were not confirmed against primary sources.

## 1. Self-learning agents (Hermes et al.)

| System | Creation | Trigger | Dedup/staleness | Review | Scope |
|---|---|---|---|---|---|
| Hermes (Nous) | Agent drafts a skill after complex tasks, error recoveries, or user corrections [UNVERIFIED thresholds]. Also MEMORY.md/USER.md with char caps | Memory is always on as a frozen per-session snapshot. Skills use progressive disclosure: name and summary first, body on demand | Hard char cap forces consolidation. `patch` is preferred over rewrite. Users report overlapping/conflicting skills and bloat | None | User-global |
| Letta | Background "sleep-time/dreaming" agents reflect asynchronously | Memory blocks always in context | Every N steps or on compaction. Optional reviewer pass | Optional | Shared blocks |
| OpenHands | Human-written | **Keyword `triggers:`** | — | n/a | Repo + global |
| Devin Knowledge | Human, plus auto-suggestions from feedback | Natural-language trigger description per item; can be pinned to repos | "Suggest update" | **Suggestions need approval** | Enterprise/org/repo |
| Windsurf | Agent-written memories; human-written rules | always / model-decision / glob / manual | Docs say "promote memories into rules" | UI | Workspace |
| Cline memory bank | Agent writes 6 fixed files by convention | Reads all at task start | Manual full review | Implicit | Repo |

**Takeaways:**
- **Two-tier load.** Inject ids and one-line summaries, and fetch full text on demand.
- **Typed triggers.** The extractor should emit globs, keywords, and an NL "applies when" line. Leaving relevance to the model is the least reliable option.
- **Hard per-domain caps.** They force merging rather than appending.
- **Patch, don't regenerate.** Keep ids stable across re-extraction.
- **Human approval gate.** Hermes has none, and its failure modes show the cost.
- **Async cadence.** Run extraction as a background job.
- **Separate stores.** Keep agent self-notes apart from the provenance-backed rules. An agent note can become a *proposed* rule.
- **No prior art for provenance or cross-scope conflict resolution.**

## 2. Harness rule systems

**Convergent pattern.**
- Activation modes: **always / path-glob (on file touch, lazy) / described (description in context, body pulled) / manual @**.
- Org rules arrive either as a pushed file (Claude managed CLAUDE.md, Windsurf/Amp `/etc`, Kiro via MDM) or as a vendor dashboard (Cursor Team Rules, Copilot org, Tabnine). Either way they can't be opted out of, or they take precedence.
- Conflict handling is mostly "concatenate and let the model decide". Only Cursor and Tabnine state "org wins".
- Size budgets are set per file, roughly 200–500 lines or 6–50k chars.
- AGENTS.md is the universal nested-scope format.

**Hook context injection (verified from docs/source):**

| Agent | Pre-tool | Post-tool | Turn/prompt start | Session start |
|---|---|---|---|---|
| Claude Code | ✅ `additionalContext` (10k cap) | ✅ | ✅ UserPromptSubmit | ✅ |
| Codex CLI | ⚠️ docs say yes but are ambiguous; needs a live test | ✅ PostToolUse | ✅ UserPromptSubmit | ✅ |
| Gemini CLI | ❌ BeforeTool can only allow/deny/rewrite args | ✅ AfterTool | ✅ BeforeAgent | ✅ |
| opencode | ❌ `tool.execute.before` mutates args only | ✅ `tool.execute.after` | ✅ `chat.message` / `experimental.chat.system.transform` (experimental API) | ✅ |

**Implication.**
- The only injection points all four agents share are **turn/session start** and **after a tool runs**.
- Design for that. Attach a path's rules on the **Read** result, before any Edit. Match the prompt text at turn start.
- Pre-tool injection should be a Claude/Codex bonus, not the foundation.

**Claude `.claude/rules` `paths:` reliability.** There are many bug reports: rules not loading, multi-path rules failing silently, rules ignored in `~/.claude/rules`, rules not injected when launched from a subdirectory, and rules loading globally anyway (#16853, #17204, #33581, #21858, #65257, #16299). Native path rules are therefore not a dependable delivery path.

## 3. Extraction, governance, conversion

**Review tools.**
- CodeRabbit imports existing agent files, uses glob-scoped path_instructions, and keeps chat-learned "learnings" with no review.
- Qodo has a monthly auto best-practices job that mines accepted suggestions. Its **Rules System** (Feb 2026) is the closest prior art: versioned rules with scope, owner and lifecycle; a discovery agent; a "Rules Expert" that flags conflicts, duplicates, outdated rules and low-signal rules; and per-rule violation metrics.
- Greptile has org, repo and per-directory cascading rules. It suggests learned rules, which an admin then approves, and tracks "Last Applied" per rule.
- Graphite tracks acceptance rate per rule, used for pruning.

**Extraction research.**
- **De Jure** (arXiv 2604.02276): decompose to rule units, run an LLM judge, then bounded repair.
- **Deontic** (2506.08899, 2608.10329): actor-modal-action-object tuples with a **closed modal lexicon** (must/shall/may).
- **Prose2Policy** (2603.15799): validate rules mechanically.
- **Google LangExtract:** every extraction is tied to **exact char offsets** in the source. This is the anti-hallucination primitive. Reject any rule whose quote isn't found verbatim.

**Dedup/conflict.** There's no standard tool. A practical approach: cluster candidates with embeddings, then have an LLM adjudicate (duplicate / refines / conflicts). Keep both rules plus a `conflicts_with` link for human review.

**Conversion.**

| Tool | License | Formats | Footprint | Quality |
|---|---|---|---|---|
| markitdown | MIT | docx/pptx/xlsx/pdf/html/… | light (pip extras, no ML) | Office good; PDF weak on tables and multi-column layouts |
| docling | MIT | widest | heavy (torch and model weights) | best on PDFs and tables |
| unstructured | Apache-2.0 | wide | heavy system deps [UNVERIFIED] | RAG-chunk oriented |
| pandoc | GPL | docx/html (pptx reader added Nov 2025), no PDF | single binary | excellent docx/html |

Recommendation: **markitdown by default, docling as an opt-in for PDFs and tables.**

**Freshness.** Most tools are weak here. Rules persist until someone deletes them. Staleness signals in use are Greptile's "Last Applied" and Graphite's acceptance rate. **No tool documents invalidation driven by a source-doc hash**, so this is new ground.

## Sources
Hermes: mranand.substack.com/p/inside-hermes-agent-how-a-self-improving · mintlify.wiki/NousResearch/hermes-agent · Letta: docs.letta.com/guides/agents/architectures/sleeptime · OpenHands: docs.openhands.dev/usage/prompting/microagents-keyword · Devin: docs.devin.ai/product-guides/knowledge · Cursor: cursor.com/docs/context/rules · Claude: code.claude.com/docs/en/memory, /hooks · Copilot: docs.github.com/en/copilot/how-tos/configure-custom-instructions · Kiro: kiro.dev/docs/steering · Gemini: geminicli.com/docs/hooks/reference · opencode: github.com/sst/opencode packages/plugin/src/index.ts · Codex: learn.chatgpt.com/docs/hooks · Qodo: qodo.ai/blog/introducing-qodo-rule-system · Greptile: greptile.com/docs/code-review/custom-standards · Graphite: graphite.com/docs/ai-review-customization · CodeRabbit: docs.coderabbit.ai/knowledge-base · arXiv 2604.02276, 2506.08899, 2608.10329, 2603.15799 · github.com/google/langextract · github.com/microsoft/markitdown · github.com/docling-project/docling
