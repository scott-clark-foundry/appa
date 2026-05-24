---
title: brief · phase 4 · feat/skills
phase: 4
branch: feat/skills
tier: service
---

# Brief: phase 4 · feat/skills

**Tier:** service

**Goal.** Build a skills catalog at `vault/skills/` using the Skills-spec format. Match incoming turns to skills by embedding similarity over descriptions. Inject the matched bodies into the chat Agent's system prompt under a token budget. Pick up file changes without restart.

**Starting state.** Init plus phases 1, 2, and 3 have shipped:

- Phase-1 transcripts and vault-write primitives, including the single-writer `asyncio.Lock` (ADR-009) and provenance helpers
- Phase-2 hybrid recall (sqlite-vec + FTS5), embeddings wrapper at `app/recall/embeddings.py` (I9-compliant), and a system-prompt callback in the chat loop
- Phase-3 declarative memory with Skills-spec frontmatter, contradiction detection, hot/cold tiering, LRU aging, the `direct.model_request` extraction pattern, and a second system-prompt callback
- Three separate SQLite stores under `INDEX_ROOT`: `index.db` (transcripts) and `memory.db` (memory). Phase 4 likely adds a third.
- ADRs 001-021 baked in; Logfire tracing for every model call (I5)

**Inputs.**

- Skill files under `vault/skills/`. Two shapes coexist:
  - Single file: `vault/skills/{name}.md`
  - Directory: `vault/skills/{name}/SKILL.md`, with optional sibling `references/` and `scripts/` subdirectories
- The current turn's user message
- The phase-2 embeddings wrapper (for description embedding)
- Filesystem change events from a watchdog observer

**Outputs.**

- A skills SQLite store (location and parallelism decision open) carrying one row per skill: name, file_path, description, body, metadata, embedding model, content hash
- A `@agent.system_prompt` callback that injects matched skill bodies for each turn, packed under `SKILL_BUDGET` (default open)
- Hot-reload: changes to skill files take effect without restart
- A startup sweep that reconciles the index against the vault before the chat endpoint accepts connections
- Architecture.md section: "skills: matching, loading, hot-reload"

**Done criteria.**

- The catalog loads on startup; `assistant skills status` reports counts.
- A turn whose content matches a skill's description (by embedding similarity above threshold) loads that skill's body into the system prompt for that turn.
- Editing a skill on disk takes effect within a few seconds without restart, observable in the next turn's system prompt.
- Deleting a skill on disk removes it from the catalog within the same window.
- Multi-file skills (with `SKILL.md` in a subdirectory) load equivalently to single-file skills; their `references/` and `scripts/` exist on disk but are not auto-loaded at this phase.
- Eval fixtures exist for skill-match precision and skill-following adherence.
- Full CI green; no regression in phases 1-3.
- CHANGELOG entry under `## [unreleased]`; NOTES.md section explaining the one concept this phase teaches.
- ADRs filed for: skills index placement, matching algorithm, budget and packing, injection order in the system-prompt stack, hot-reload mechanism, references and scripts deferral.

**Non-goals.**

- Agent-written skills. The `metadata.source` field reserves the slot; phase 8 fills it.
- Skill drafting from trace patterns. Phase 8.
- Skill optimization via DSPy / GEPA. Phase 10.
- Auto-loading `references/` or `scripts/` content. The agent has no tools yet; deferred to phase 6 and 7 when tools land.
- Skill versioning beyond what the filesystem provides. Phase 10's auto-tuning will revisit.
- A skill UI. Authoring happens in any markdown editor (Obsidian, VS Code, vim) against the vault.
- Cross-skill dependency resolution. Phase 4 treats skills as independent records.
- Multi-tenant or shared skill catalogs.

**Persistence.**

- Skill files live in `vault/skills/`. Two layouts:
  - `vault/skills/{name}.md` for single-file skills.
  - `vault/skills/{name}/SKILL.md` plus optional `references/` and `scripts/` for multi-file skills.
- Frontmatter follows Skills-spec per I6: top-level `name` and `description`; phase-4 fields under `metadata.*`. Required `metadata.*` fields: `source` (`user-written` for phase 4; `agent-written` and `vendored` reserved), `created_at`, `last_updated_at`. Optional: `priority` (integer; default 0; ties broken by similarity then by name), `tags` (list, free-form).
- Body holds the procedural content. The model reads this when the skill matches.
- The skills store carries one row per skill, plus a vector table over description and an FTS5 table over description and body. Placement (parallel `skills.db` versus namespace inside `memory.db`) is left to the architecture; the brief leans parallel for the same lifecycle-distinctness reason cited in phase 3.

**Where it runs.** Operator's laptop, single process. No deployment surface.

**Constraints.**

- Description embedding routes through the phase-2 embeddings wrapper per I9. No direct provider SDK imports.
- All vault writes from this phase go through the phase-1 vault writer per ADR-009. Phase 4 does not write to the vault from app code (the operator authors skills externally); phase 8 will be the first writer.
- The hot-reload subscriber must respect the vault lock if any operation ever writes to the vault on its behalf. Phase 4's hot-reload is read-only against the vault.
- Logfire tracing covers: matching (query length, candidates considered, threshold filter, fused score, latency), loading (skill name, body size, latency), hot-reload events (path, change type, action taken), and startup sweep (counts).
- Match-on-input uses embedding similarity between the user turn and each skill's description. Optional secondary filter via FTS5 BM25 over description and body for query terms that should match literally.
- Threshold-based filtering plus greedy pack into `SKILL_BUDGET` (default open; suggested 2000 tokens). Sorting by similarity descending; ties broken by `metadata.priority` (higher wins), then by name (stable).
- The skills callback is one of three `@agent.system_prompt` callbacks. Order in the stack is a decision the architecture commits to, superseding ADR-019.

**Failure tolerance.**

- Skill file with malformed frontmatter: log a structured warning, skip the file, leave it on disk for the operator to fix. The catalog continues without it.
- Embedding provider down during matching: degrade to BM25-only over description and body, log the degradation. If both branches fail, skip the skills section for that turn.
- Watchdog backend not available on the host OS or filesystem: fall back to a polling sweep every `SKILL_POLL_INTERVAL` (default open). Log the fallback at startup.
- Hot-reload event arrives for a file that fails to parse: log, leave the prior index row in place. The operator notices via `assistant skills status` warnings or the log.
- Embedding model changed: same fail-fast policy as the recall and memory stores. Operator runs `assistant skills rebuild`.
- Concurrent edits (operator saves while watchdog reads): hash check on read; if the file mutates mid-read, retry once. If still inconsistent, log and defer to the next event.

**Open questions (left to the architecture).**

- Skills store placement: parallel `skills.db` versus namespace inside `memory.db`. Lean parallel for lifecycle distinctness (skills are curated and structured; memory is extracted and mutated). Decide.
- Skill match threshold: starting value and whether to expose as `SKILL_MATCH_THRESHOLD` for tuning. Phase-5 evals will pressure-test.
- `SKILL_BUDGET` default. The brief suggests 2000 tokens (enough for two or three typical skill bodies). Architecture commits.
- Injection order in the system-prompt stack. Phase 3's ADR-019 set: base, memory, recall. Skills slot somewhere. Candidates: base, memory, skills, recall (procedural before specific past), or base, memory, recall, skills (skills closest to the user message). Architecture decides and supersedes ADR-019.
- Whether descriptions are always-loaded in addition to bodies of matched skills. The Anthropic Agent Skills spec's tier-1 model says yes; the brief leans no because matching happens externally via embedding and an always-loaded catalog spends context budget without earning it. Architecture decides and documents the deviation from spec intent.
- Watchdog details: which library (`watchdog` is the obvious choice), polling fallback interval, debounce behavior for rapid saves.
- Tie-breaking when many skills match: by similarity, by `metadata.priority`, by `metadata.source` (user-written preferred over agent-written), or some combination.
- Multi-file skills: how to handle a directory whose `SKILL.md` exists but whose `references/` or `scripts/` paths contain dangling references. Phase 4 only indexes the SKILL.md content; the references' existence is checked at load time but not enforced.
- Indexing the body in FTS5 in addition to the description. The brief leans yes (descriptions are short; bodies hold the matchable surface area for keyword queries). Architecture decides.
