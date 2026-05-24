---
title: brief · phase 2 · feat/semantic-recall
phase: 2
branch: feat/semantic-recall
tier: service
---

# Brief: phase 2 · feat/semantic-recall

**Tier:** service

**Goal.** Build a hybrid retrieval index (embeddings plus BM25) over completed transcripts and inject the top-k relevant past exchanges into the system prompt at the start of every turn.

**Starting state.** Init and phase 1 have shipped:

- Chat loop with the event bus (`SessionStart`, `TurnStart`, `TurnStreamChunk`, `TurnEnd`, `TurnCancelled`, `SessionEnd`)
- Transcripts persisted at `vault/transcripts/{YYYY-MM-DD}/{session}.md` with `## turn N` headings (ADR-008)
- Manifest at `vault/.manifest/transcripts.json` tracking written transcripts with content hashes
- Vault-write primitives (`paths`, `manifest`, `writer`, `provenance`) with single-writer `asyncio.Lock` (ADR-009), staging plus atomic rename
- ADRs 001-009 baked in; Logfire tracing for all LLM calls (I5); no direct provider SDK imports in app code (I9)

**Inputs.**

- Completed transcript files under `vault/transcripts/` (status `completed` or `cancelled`, present in the manifest)
- The current turn's user message (for pre-turn retrieval)
- Current session id (so the index does not surface the current session's own turns)
- Embedding provider config (separate from the chat model config)

**Outputs.**

- An index persisted outside the vault at a configured path (e.g., `~/.local/share/assistant/index/`), holding embeddings plus a lexical BM25 index
- Pre-turn retrieval that injects top-k (3 to 5) relevant past exchanges into the system prompt for the current turn only
- Citations on each injected exchange (transcript path + turn number) so the assistant can refer back if asked
- Logfire spans for every retrieval (query, k, top scores, latency)
- An architecture.md section: "semantic recall and hybrid retrieval"

**Done criteria.**

- New transcripts are indexed after their session ends, without blocking the next chat turn
- Pre-turn retrieval injects the configured top-k exchanges into the system prompt; the LLM receives them
- Eval fixtures exist for: Recall@k, MRR (bootstrapped query → expected past-exchange pairs from author's own history), and faithfulness (LLM-as-judge when retrieved context is summarized into a response)
- All three fixture buckets load with the phase-1 fixture format; verifiable buckets can be scored by the standalone runner
- Full CI green; no regression in phase-1 capabilities
- CHANGELOG entry under `## [unreleased]`; NOTES.md section explaining the one concept this phase teaches
- ADRs filed for the index backend choice and any other decisions the architecture commits to

**Non-goals.**

- Per-topic chunking or clustering (deferred; one user message plus one assistant response is one chunk)
- Cross-session declarative memory in the system prompt (phase 3)
- Real-time index updates while a turn is in flight; transcripts are indexed only after their session ends
- Retrieval over anything other than transcripts (no memory, no skills, no external documents)
- Reranking, query rewriting, query expansion, hypothetical-document expansion
- Stored summaries of retrieved context; each retrieval is fresh
- Index sharing across machines or users

**Persistence.**

- Index lives outside the vault at a configured path. Vault stays plain markdown.
- Chunking is per-turn: one user message plus its assistant response is one chunk.
- Each chunk carries a reference back to the transcript path and turn number so retrievals can be cited.
- Only fully-written transcripts (present in the manifest, status `completed` or `cancelled`) are eligible for indexing. Half-written or staged files are skipped.

**Where it runs.** Author's laptop, single process, macOS or Linux. No deployment surface.

**Constraints.**

- Embeddings route through the indexer's own provider-agnostic interface (per I9), not through pydantic-ai. This is the one place a non-pydantic-ai model call is permitted; ADR-001 applies to chat and structured outputs only.
- All chat LLM calls continue to route through pydantic-ai per ADR-001
- Vault is not written from this phase. If any vault write becomes necessary, it goes through the phase-1 writer per ADR-009.
- Logfire tracing covers retrievals (per I5) and indexing operations (chunk counts, durations)
- Python at the version pinned in `pyproject.toml`; new dependencies justified in architecture.md
- Index path configured via `pydantic-settings` (e.g., `INDEX_ROOT`); defaults to a sensible OS-appropriate path
- Eval suite (I4) is extended with at least one verifiable bucket per behavior (retrieval, indexing) and one rubric-based bucket (faithfulness)

**Failure tolerance.**

- Missing index on startup: build from scratch by scanning the manifest and indexing every completed transcript
- Stale index (transcripts written after the last index update): sweep on startup; index incrementally on `SessionEnd` thereafter
- Indexing fails for one transcript: log, skip, continue. The index is best-effort; transcripts are the source of truth.
- Retrieval fails at turn start: log the failure, proceed without injected context. The chat still works; recall degrades silently rather than blocking the turn.
- Embedding provider unavailable: degrade to BM25-only retrieval and log

**Open questions (left to the architecture).**

- Index backend: chromadb or sqlite-vec. Pick sqlite-vec only if some other phase-2 concern also wants sqlite; otherwise chromadb.
- Embedding model choice (size, provider). Document the cost-per-1k-chunks estimate in the ADR.
- BM25 implementation: bundled with the embedding store, or a separate dependency (`rank_bm25` or similar).
- Index update mechanism: subscribe to `SessionEnd` events (phase-1 event bus makes this clean) versus a polling sweep.
- Citation format for injected context: transcript path plus turn number, or session id plus turn number.
- Hybrid scoring: reciprocal rank fusion, linear combination, or BM25 as a candidate filter before embedding rerank.
