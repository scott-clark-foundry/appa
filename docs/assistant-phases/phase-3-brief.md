---
title: brief · phase 3 · feat/declarative-memory
phase: 3
branch: feat/declarative-memory
tier: service
---

# Brief: phase 3 · feat/declarative-memory

**Tier:** service

**Goal.** Extract durable facts about the operator from every completed turn, persist them as markdown in `vault/memory/`, and inject the most-relevant hot tier into the Agent's system prompt at every turn under a token budget. Older facts age into a cold tier that is retrievable but not always loaded.

**Starting state.** Init plus phases 1 and 2 have shipped:

- Chat loop with event bus; transcripts persisted via the phase-1 vault writer (single-writer `asyncio.Lock`, staging plus atomic rename, manifest)
- Provenance markers defined in `app/persistence/vault/provenance.py` (declared in phase 1, unused until now)
- sqlite-vec hybrid index over transcripts with the embeddings wrapper at `app/recall/embeddings.py` (I9-compliant single point of provider knowledge for embeddings)
- pydantic-ai `system_prompt` callback in the chat loop (phase 2's retrieve injection lives here; phase 3 stacks on top)
- ADRs 001-014 baked in; Logfire tracing for all LLM calls (I5)

**Inputs.**

- The completed turn record at `TurnEnd` (user message plus assistant response, session id, turn number)
- Existing entries under `vault/memory/` (for contradiction detection and aging decisions)
- Current chat session id (for citation back to the originating exchange)
- The phase-2 embeddings wrapper (for contradiction similarity)

**Outputs.**

- Memory entries in `vault/memory/` as Skills-spec-compliant markdown: top-level `name` and `description`, with all phase-3 metadata (created_at, last_updated_at, last_referenced_at, source_session, source_turn, tier, supersedes, confidence, provenance ratio) under `metadata.*` per the spec's client-key escape hatch
- Updated entries when new facts contradict existing ones (superseding with a citation pointer to the contradicting exchange)
- Hot-tier entries injected into the Agent's system prompt at every turn, under a configured token budget
- A memory index (separate from the transcripts index per phase-2's "what this enables" note, unless architecture revisits) enabling cold-tier retrieval
- An architecture.md section: "declarative memory: extraction, tiers, contradiction handling"

**Done criteria.**

- Planted-fact recall across sessions: a fact written to `vault/memory/` in session A is present in session B's system prompt when the new turn is relevant to that fact
- Contradiction resolution with citation: a new fact that contradicts an existing hot entry causes the old entry to be marked `supersedes` with a pointer to the new fact and its source turn; the new fact becomes the live entry
- Token budget enforced: the injected hot tier never exceeds `MEMORY_HOT_TOKENS` (default 1000); over-budget hot entries age to cold
- Background extraction does not block the chat loop (the next turn does not wait on extraction completing)
- Eval fixtures exist for the three behaviors above plus a fixture that exercises aging
- Full CI green; no regression in phase-1 or phase-2 capabilities
- CHANGELOG entry under `## [unreleased]`; NOTES.md section explaining the one concept this phase teaches
- ADRs filed for tier organization, aging policy, contradiction handling, and memory-index placement

**Non-goals.**

- Procedural memory or skills (phase 4)
- Memory about anyone other than the operator. Facts may reference other people but they are stored from the operator's perspective ("operator's manager is X"), not as standalone profiles
- A dedicated UI for editing memory; the vault is plain markdown editable in any tool
- Real-time memory updates inside a turn; extraction runs after the turn closes
- Memory deletion. Aging supersedes; nothing is removed
- Multi-tenant memory or cross-user data sharing
- Inferring sensitive attributes (health, beliefs, demographics) the operator did not state
- Confidence learning across many extractions; confidence is a per-write score, not trained over time

**Persistence.**

- Memory files live in `vault/memory/` as markdown. Format is Skills-spec compliant per I6: top-level `name` and `description` frontmatter; all phase-3 metadata rides under `metadata.*` per the spec's client-key escape hatch.
- The `description` field carries the fact statement (compact, self-contained). The body holds extended context, supersession history, and any longer-form provenance.
- Every entry carries provenance: source session and turn, the extraction model used, and the provenance ratio (per the phase-1 provenance helper), all under `metadata.*`.
- Hot and cold tiers are functionally distinct but their on-disk organization is open (single folder with `tier:` frontmatter, two folders, or a single `hot.md` per the Ar9av convention; architecture decides)
- Cold entries are indexed for retrieval. Schema and store placement (parallel `memory.db` versus shared `index.db` with namespacing) is open; the phase-2 architecture proposed parallel, which the phase-3 architecture confirms or revisits
- All writes go through the phase-1 vault writer per ADR-009. This is the first phase where a background writer exercises the single-writer lock concurrently with the chat path. The lock contract is now load-bearing.

**Where it runs.** Operator's laptop, single process. No deployment surface.

**Constraints.**

- Background fact extraction uses pydantic-ai's `direct.model_request` (a one-shot model call outside the chat Agent), not a separate Agent. Per ADR-001 and I9.
- All chat LLM calls continue to route through the pydantic-ai chat Agent per ADR-001
- Embeddings (for contradiction similarity and cold-tier indexing) continue to route through `app/recall/embeddings.py` per I9. No direct provider SDK imports.
- Memory files are Skills-spec compliant per I6. `name` and `description` at the top level; all phase-3 fields under `metadata.*`. The vault has one format for everything the agent writes, and memory adopts it. Not because memory entries are skills (they are not), but because the format is common.
- The phase-1 vault writer's `asyncio.Lock` serializes all vault writes from any path. Background extraction must acquire and release the lock cleanly; long writes degrade chat responsiveness, so writes must stay small.
- Logfire tracing covers extraction (per-turn model call, tokens, latency), contradiction detection (similarity scores, supersession decisions), and memory injection (entries injected, token count)
- Token budgeting happens before injection. Hot entries are ranked by relevance to the current turn plus recency, then packed under the budget.
- Provenance markers (`^[inferred]`, `^[ambiguous]`) defined in phase 1 are now live. Extraction marks low-confidence statements with `^[inferred]` and ambiguous-source statements with `^[ambiguous]`.

**Failure tolerance.**

- Extraction model call fails: log, skip this turn's update, continue chat. The next turn will try again over fresh content.
- Vault write fails after successful extraction: log; the fact is lost. No retry queue at phase 3.
- Contradiction detection fails (embedding provider down): write the new fact without contradiction handling, log the degradation. A future sweep can reconcile.
- Token budget overrun after aging cycle: drop the lowest-ranked hot entry until under budget; never inject over budget. Log the eviction.
- Memory file corrupted (operator edited it badly through Obsidian): on load failure, skip the file, log a warning, continue. The file remains on disk for the operator to repair.
- Background writer blocks on the vault lock: extraction work continues; only the write step waits. If the write exceeds a timeout, abandon and log.

**Open questions (left to the architecture).**

- Tier organization on disk. Skills-spec is one entry per file, so the `hot.md` Ar9av convention (one file, many entries) does not apply directly. Choose between a single folder with `metadata.tier:` frontmatter or two folders (`vault/memory/hot/`, `vault/memory/cold/`).
- Relationship between Skills-spec progressive disclosure and the hot/cold strategy. Skills load tier-1 (`name` + `description`) unconditionally for every skill in the catalog; memory cannot do this unconditionally because growth is unbounded. The hot tier is the subset of entries whose tier-1 content fits the configured token budget and ranks high enough for the current turn; cold is everything else. Body-on-match (Skills-spec tier-2) still applies to retrieved cold entries. Confirm in architecture or revise.
- Aging algorithm: recency-only, relevance-only (recomputed per turn), or a hybrid score. Either way, aging runs after writes, not during injection.
- Memory index placement: a parallel `memory.db` with the same schema shape as `index.db`, or the same `index.db` with a namespace column. Phase 2's architecture leaned parallel; phase 3 confirms or revisits.
- Extraction prompt structure and granularity: one fact per turn, multiple, or whatever the model returns under a schema. Document the prompt in the ADR.
- Contradiction threshold: cosine similarity value above which two facts are considered to address the same subject and require resolution.
- Supersession semantics: physical move of the superseded entry to a `superseded/` directory, in-place marking, or moving to cold tier.
- Whether extraction triggers on `TurnEnd` (every turn) or `SessionEnd` (batched). The plan says "after each turn"; revisit only if turn-by-turn extraction proves too costly.
- Eviction direction at budget overrun: drop oldest, drop lowest-relevance, or drop entries with the highest confidence loss from aging. Default to lowest-relevance for the current turn; relevance recomputed per turn anyway.
