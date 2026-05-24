---
title: plan · phase 2 · feat/semantic-recall
phase: 2
branch: feat/semantic-recall
references:
  - phase-2-brief.md
  - phase-2-architecture.md
---

# PLAN: phase 2 · feat/semantic-recall

Ten tasks. Execute roughly in order; the depends-on field shows actual blocking constraints. Each task is one focused Claude Code session.

## Status

- [ ] T01: SQLite index module (schema, connection, migrations)
- [ ] T02: embeddings wrapper and transcript chunker
- [ ] T03: ingestion path (`SessionEnd` subscriber)
- [ ] T04: retrieval path (KNN + BM25 + RRF)
- [ ] T05: startup delta sweep
- [ ] T06: chat-loop `system_prompt` callback and `main.py` wiring
- [ ] T07: index CLI subcommands (status, rebuild)
- [ ] T08: integration tests (round-trip, sweep, degradation)
- [ ] T09: eval fixtures (Recall@k, MRR, faithfulness)
- [ ] T10: docs (ADR-010 through ADR-014, CHANGELOG, NOTES.md)

---

## T01: SQLite index module (schema, connection, migrations)

Depends on: none

Scope. Create `app/recall/index.py`. Owns the SQLite connection, loads the sqlite-vec extension, creates the schema, and runs idempotent migrations.

Schema:

- `_meta`: schema_version (int), last_embedding_model (string).
- `chunks`: id (pk autoincrement), transcript_path, session_id, turn_number, user_text, assistant_text, content (concatenation for FTS), started_at, ended_at, cancelled (bool), embedding_model.
- `chunks_vec`: sqlite-vec virtual table, embedding dim configurable at schema-creation time.
- `chunks_fts`: FTS5 virtual table over `content`.
- `ingestions`: transcript_path (pk), transcript_sha256, indexed_at, embedding_model.

Public surface: a function or small class that opens the database from `INDEX_ROOT`, runs migrations, and exposes the connection. Migration logic checks `_meta.schema_version` and upgrades step by step.

Acceptance.

- Unit tests: create a fresh database, verify all tables exist with the documented columns.
- Migration test: start from a stale schema_version, verify migration runs and bumps the version.
- sqlite-vec extension loads; failure produces a clear error with an install hint.
- FTS5 is available in the linked SQLite; failure produces a clear error.
- Embedding dim is parameterized (so future model changes can adjust if needed).

Open. Embedding dim defaults to 1536 per ADR-013. Storing per-chunk dim metadata is deferred; current model is recorded in `_meta` and `ingestions`.

---

## T02: embeddings wrapper and transcript chunker

Depends on: none

Scope. Two small modules. Bundled because each is small and they have no shared logic but both gate T03.

- `app/recall/embeddings.py`: provider-agnostic embedding wrapper. Accepts a model string like `openai:text-embedding-3-small`. Parses the provider prefix and dispatches to the appropriate provider SDK. Exposes an async `embed` method that takes a list of strings and returns a list of vectors, one per input. Internal provider dispatch handles `openai:*` for phase 2; unknown prefixes raise. This is the single point in the app where an embedding provider SDK is imported (per I9).
- `app/recall/chunker.py`: a pure function that takes a transcript markdown file path and returns a list of chunk records. One record per `## turn N` heading, carrying turn_number, user_text, assistant_text, started_at, ended_at, and a cancelled flag. Skips a turn only if both user_text and assistant_text are empty (defensive).

Acceptance.

- Embeddings: unit tests against fixtures with a mocked provider client. Round-trip: embedding two strings returns two vectors of the expected dim.
- Embeddings: unknown provider prefix raises a clear error.
- Chunker: snapshot tests against phase-1 transcript fixtures (completed two-turn, cancelled mid-turn, single-turn). Records match the expected shape.
- Chunker: cancelled turns with partial assistant content are kept, not dropped.

Open. Batch size for embedding calls (e.g., embed all chunks of one transcript in one batched call). Default to one batch per transcript; revisit if API limits force smaller.

---

## T03: ingestion path (`SessionEnd` subscriber)

Depends on: T01, T02

Scope. `app/recall/ingest.py`. A subscriber to the phase-1 event bus that, on `SessionEnd`:

1. Loads the transcript file via phase-1 vault paths.
2. Verifies the transcript is present in the phase-1 manifest with status completed or cancelled. If not, log and exit.
3. Calls the chunker.
4. Calls the embeddings wrapper for all chunks in one batched call.
5. In a single SQLite transaction: inserts into `chunks`, `chunks_vec`, `chunks_fts`; upserts the `ingestions` row. All carry the current `EMBEDDING_MODEL`.
6. Emits a Logfire span: transcript path, chunk count, embedding tokens, total latency.

Failure handling:

- Embedding provider error: retry with exponential backoff (3 attempts). On final failure, leave the transcript unindexed and log a structured warning with the path.
- SQLite write error: roll back the transaction, log, do not partial-write.
- Missing transcript file: log and exit. The writer in phase 1 may have failed; ingest is not responsible for repair.

Acceptance.

- Unit tests with a synthetic `SessionEnd` event and a temp index: chunks land in all three tables; `ingestions` reflects the row.
- Idempotency: re-ingesting a transcript whose `sha256` already appears in `ingestions` with the same `embedding_model` is a no-op.
- Backoff test: provider raises a transient error twice, succeeds on the third; ingest completes.
- Persistent provider failure: ingest does not raise; transcript stays unindexed; a warning is logged.

Open. Whether ingest runs on a background asyncio task or blocks the `SessionEnd` handler. Default to a background task so `SessionEnd` returns immediately; document the implication that a process crash mid-ingest leaves a gap that the next startup sweep catches.

---

## T04: retrieval path (KNN + BM25 + RRF)

Depends on: T01, T02

Scope. `app/recall/retrieve.py`. A single async public function `retrieve` that takes the query string, the top-k count, and an optional session id to exclude. Returns a list of retrieved chunk records.

Steps:

1. Embed the query (one call via the embeddings wrapper).
2. Run sqlite-vec KNN with `LIMIT 4 * k`.
3. Run FTS5 BM25 with `LIMIT 4 * k`.
4. Combine candidates by chunk id. Compute RRF: `score(d) = sum over each result list L of 1 / (RRF_K + rank_L(d))` with `RRF_K = RECALL_RRF_K` (default 60).
5. Sort by fused score descending, take top-k.
6. Filter out chunks whose `session_id` matches the exclude argument.
7. Return records carrying id, transcript_path, session_id, turn_number, started_at, user_text, assistant_text, fused_score, vec_rank, fts_rank.
8. Emit a Logfire span: query length, k, fused scores, vec and BM25 rank lists, latency.

Failure handling:

- Embedding provider error: skip the KNN branch, run BM25-only, log the degradation.
- FTS5 query error: skip the BM25 branch, run vec-only, log.
- Both branches fail: return empty list, log.

Acceptance.

- Unit tests against a seeded index with known chunks: a query containing the planted text returns the planted match in position 1.
- Exclusion test: chunks from the excluded session_id are absent from the result.
- Vec-only fallback test: embeddings raise; retrieval returns BM25-ranked results.
- BM25-only fallback test: FTS5 raises (simulated); retrieval returns vec-ranked results.
- Empty index: returns an empty list without error.

Open. Whether to expose `vec_rank` and `fts_rank` on the result type or keep them internal. Default to exposing; the phase-5 eval harness will want them for failure analysis.

---

## T05: startup delta sweep

Depends on: T03

Scope. `app/recall/sweep.py`. A function called at app startup, before the chat endpoint accepts connections:

1. Read the phase-1 manifest at `vault/.manifest/transcripts.json`.
2. Read the `ingestions` table.
3. Compute the delta: manifest entries with `status in {completed, cancelled}` whose `transcript_path` is missing from `ingestions`, or whose `sha256` differs from the indexed `transcript_sha256`.
4. For each delta entry, call into the ingest path synchronously. Same code as the `SessionEnd` subscriber, but invoked from sweep with no event-bus involvement.
5. Log a summary: count swept, count skipped (already current), count failed.

Embedding-model mismatch handling: if `EMBEDDING_MODEL` differs from `_meta.last_embedding_model`, the sweep refuses to run and instructs the operator to use the CLI rebuild (T07). This is the architecture's fail-fast policy on model change.

Acceptance.

- Unit test: a manifest with 5 completed transcripts, an empty index. After sweep, all 5 are indexed.
- Delta test: 3 of 5 already indexed; sweep ingests only the missing 2.
- Sha-mismatch test: a manifest row's sha differs from `ingestions`; sweep re-ingests that row.
- Model-mismatch test: `EMBEDDING_MODEL` differs from `_meta.last_embedding_model`; sweep raises a clear error directing to `assistant index rebuild`.

Open. Whether sweep is concurrent (asyncio gather a few transcripts at a time) or strictly sequential. Default to sequential; concurrency is easy to add later if startup latency becomes a complaint.

---

## T06: chat-loop `system_prompt` callback and `main.py` wiring

Depends on: T03, T04, T05

Scope. Two modifications.

`app/chat/loop.py`. Add a pydantic-ai `@agent.system_prompt` callback. On each turn the callback reads the current user message and current session id from the `RunContext`, calls `retrieve.retrieve` with `k = RECALL_TOP_K` and `exclude_session = current_session_id`, and returns a rendered recall context string. Empty list returns empty string. Format matches the architecture: top-level "Recall context" heading, one sub-heading per chunk with citation, then the user and assistant text.

`app/main.py`. At startup: open the index (T01), run `sweep` (T05), subscribe the ingest handler (T03) to the event bus. At shutdown: close the SQLite connection cleanly.

Acceptance.

- Manual smoke: start the app with a populated index; send a chat turn referencing a past topic; verify the system prompt for that turn includes a recall section with at least one chunk (visible in the Logfire trace).
- Empty-index smoke: start with no prior sessions; verify no recall section is injected; chat works normally.
- Current-session-exclusion smoke: send three turns in one session that reference each other; verify retrieval does not return earlier turns from the same session.
- No regressions in phase-1 smoke tests or persistence round-trip.

Open. The exact mechanics of reading the current user message and session id out of `RunContext`. Defer; the implementing session reads the pydantic-ai docs and picks the idiomatic approach. If the framework's callback signature does not carry the session id, plumb it via `deps_type` on the Agent.

---

## T07: index CLI subcommands (status, rebuild)

Depends on: T01, T03, T05

Scope. Two CLI subcommands wired into the existing `assistant` CLI.

- `assistant index status`. Opens `index.db`, prints chunk count, distinct transcript count, the current `_meta.last_embedding_model`, and the count of manifest entries missing from `ingestions` (the current gap). Read-only.
- `assistant index rebuild`. Drops `chunks`, `chunks_vec`, and `chunks_fts`; clears `ingestions`; updates `_meta.last_embedding_model` to the current `EMBEDDING_MODEL`; runs `sweep` against the full manifest. Prompts for confirmation unless `--yes` is passed. A `--dry-run` flag prints the plan without executing.

Acceptance.

- `status` against a populated index prints the expected counts.
- `rebuild` against a populated index drops and re-creates; a subsequent `status` shows the same chunk count if the manifest is unchanged.
- `rebuild` requires confirmation unless `--yes`; `--dry-run` prints without doing.
- Both subcommands respect `INDEX_ROOT` from settings.

Open. Whether `rebuild` supports a `--model` flag to override `EMBEDDING_MODEL` for the rebuild run (useful for trying a new model without permanently switching). Defer; revisit if model swaps become frequent during phase 5.

---

## T08: integration tests (round-trip, sweep, degradation)

Depends on: T06

Scope. `tests/integration/test_recall.py`. End-to-end tests against a real FastAPI test client, a temp vault, and a temp `INDEX_ROOT`.

Tests:

- Index round-trip: complete a chat session; verify the transcript appears in `chunks`, `chunks_vec`, and `chunks_fts` after `SessionEnd`; verify `ingestions` is updated.
- Retrieval injection: pre-seed the index with a chunk about topic X. Send a new chat turn that queries topic X. Verify the turn's system prompt (captured via a Logfire test exporter or a test hook) contains the seeded chunk.
- Cross-session exclusion: same session has earlier turns about topic X; a new turn in that session queries topic X. Verify the system prompt does not include earlier turns from the same session.
- Startup sweep: write a transcript directly to the phase-1 vault (bypassing the running app); restart the test app; verify sweep ingests it.
- Embedding-provider degradation: configure the test to make the embedding provider raise; verify retrieval returns BM25-only results; verify ingest leaves the transcript unindexed with a warning.
- Embedding-model-change refusal: pre-seed `_meta.last_embedding_model` to a different value; verify startup sweep refuses with the expected error message.

Acceptance. All tests pass on CI. No flakiness across 10 consecutive CI runs.

Open. Mock vs real embedding provider in CI. Default to a deterministic fake provider (returns hash-based vectors) for speed and reproducibility; one optional test runs against the real provider behind a `REAL_EMBEDDINGS=1` env flag.

---

## T09: eval fixtures (Recall@k, MRR, faithfulness)

Depends on: T06

Scope. Add `vault/evals/phase-2/` with three buckets.

- `recall-at-k/`: bootstrapped (query → expected past-exchange) pairs sampled from the author's own transcripts. Format: one fixture per pair, frontmatter carrying `query`, `expected_chunk_id`, `expected_transcript_path`, `expected_turn_number`. Verifiable. A small standalone runner scores Recall@k.
- `mrr/`: same fixture format as `recall-at-k/`, scored as the mean reciprocal rank of the expected chunk in the returned list.
- `faithfulness/`: a handful of completed conversations where the assistant cited recall context. Rubric-based LLM-as-judge scoring of whether the response is grounded in the cited chunks. Frontmatter carries `conversation_path`, `cited_chunk_ids`, `rubric`.

Acceptance.

- All three buckets load with the phase-1 fixture format.
- A small standalone runner can score `recall-at-k/` and `mrr/` against the current index, without phase-5 infrastructure.
- Faithfulness fixtures exist and parse; scoring waits for phase 5.

Open. Bucket size. Target 30 to 50 fixtures per verifiable bucket; smaller gives wide error bars (per the phase-1 design note about judge-human agreement slices).

---

## T10: docs (ADR-010 through ADR-014, CHANGELOG, NOTES.md)

Depends on: T01, T03, T04, T06 (decisions need to be implemented before they are documented)

Scope.

- ADR-010: index backend (sqlite-vec).
- ADR-011: hybrid scoring (RRF with constant 60).
- ADR-012: chunking unit (per-turn).
- ADR-013: embedding model (`openai:text-embedding-3-small`, 1536-dim).
- ADR-014: index update mechanism (event-driven plus startup sweep).
- CHANGELOG entry under `## [unreleased]`; promote to a version on merge.
- NOTES.md section titled "Phase 2: semantic recall and hybrid retrieval." Explains the one concept this phase teaches: hybrid retrieval (vec + lexical) as the resilient default for conversation-as-corpus recall, with citations carrying each chunk back to its source. Reference the relevant code paths.

Acceptance.

- All five ADRs present in `docs/adr/`.
- CHANGELOG and NOTES.md updated.
- README's "what's here" section mentions semantic recall.

Open. None.
