---
title: plan · phase 3 · feat/declarative-memory
phase: 3
branch: feat/declarative-memory
references:
  - phase-3-brief.md
  - phase-3-architecture.md
---

# PLAN: phase 3 · feat/declarative-memory

Ten tasks. Execute roughly in order; the depends-on field shows actual blocking constraints. Each task is one focused Claude Code session.

## Status

- [ ] T01: SQLite memory index module (schema, connection, migrations)
- [ ] T02: extraction module and prompt
- [ ] T03: contradiction detection module
- [ ] T04: ingest pipeline with aging and retrieve stub
- [ ] T05: memory injection callback and chat-loop wiring
- [ ] T06: memory startup sweep
- [ ] T07: memory CLI subcommands
- [ ] T08: integration tests (extraction, contradiction, aging, injection)
- [ ] T09: eval fixtures (planted-fact, contradiction resolution, budget, aging)
- [ ] T10: docs (ADR-015 through ADR-021, CHANGELOG, NOTES.md)

---

## T01: SQLite memory index module (schema, connection, migrations)

Depends on: none

Scope. Create `app/memory/index.py`. Owns the memory SQLite connection, loads the sqlite-vec extension, creates the schema, runs idempotent migrations. Lives at `{INDEX_ROOT}/memory.db` by default; `MEMORY_DB_PATH` overrides.

Schema:

- `_meta`: schema_version (int), last_embedding_model (string).
- `entries`: entry_id (pk autoincrement), name (unique not null), file_path, description, body, description_tokens, created_at, last_updated_at, last_referenced_at, source_session, source_turn, tier (hot or cold), always (bool default 0), supersedes (entry_id or null, fk), supersedes_by (entry_id or null, fk), confidence (real), provenance (stated, inferred, or ambiguous), embedding_model, content_hash.
- `entries_vec`: sqlite-vec virtual table, embedding dim configurable at schema creation (default 1536).
- `entries_fts`: FTS5 virtual table over `description`.

Public surface: opens the database, runs migrations, exposes the connection. Idempotent on repeated open.

Acceptance.

- Unit tests: fresh database creation, all tables present with documented columns.
- Migration test: bump schema_version from a stale value, verify upgrade and the new version persists.
- sqlite-vec extension loads; failure produces a clear error with an install hint.
- FTS5 available; failure produces a clear error.
- Schema explicitly distinct from the recall index (different table names, different file path).

Open. None.

---

## T02: extraction module and prompt

Depends on: none

Scope. `app/memory/extract.py`. Background fact-extraction function. Called with the just-completed turn (user message, assistant response, session id, turn number). Uses pydantic-ai's `direct.model_request` (not the chat Agent) with the extraction prompt and a typed response model.

Response model: a list of `ExtractedFact` records, each carrying `name` (slug, lowercase, hyphenated), `description` (target under 30 tokens), optional `body` (extended context), `confidence` (0 to 1), `provenance` (stated, inferred, or ambiguous), and `always` (bool default false).

Prompt requirements (committed in ADR-020, document the exact text):

- Durable facts only; reject transient state.
- About the operator: preferences, attributes, relationships, ongoing work.
- Do not infer sensitive attributes the operator did not state.
- Provenance is the model's self-judgment of source: stated, inferred, or ambiguous.
- Return an empty list when nothing durable was said.

Public surface: an async function taking the turn and returning the list of `ExtractedFact`. No vault or index writes from this module.

Acceptance.

- Unit tests with a mocked `direct.model_request`: response is parsed into the typed model.
- Schema-validation test: malformed model output triggers pydantic-ai's structured-output retry (per the kytmanov three-tier pattern in phase-1 NOTES).
- Empty-input test: a no-content turn returns an empty list cleanly.
- Logfire span emitted with input tokens, output tokens, fact count, latency.

Open. Whether to include the previous N turns of context to give extraction more grounding. Default to just the current turn at phase 3; revisit when phase 5 evals show whether broader context catches references that single-turn extraction misses.

---

## T03: contradiction detection module

Depends on: T01

Scope. `app/memory/contradict.py`. Given a candidate `ExtractedFact`:

1. Embed the candidate description via the phase-2 embeddings wrapper.
2. Query `entries_vec` for the 5 nearest existing entries.
3. Filter to candidates above `MEMORY_CONTRADICT_THRESHOLD` (default 0.85).
4. If none above threshold: return `Decision(kind="fresh")`.
5. For each above-threshold candidate: `direct.model_request` with a classification prompt presenting the existing entry and the new candidate. Returns `contradiction`, `update`, or `unrelated`.
6. Return a `Decision` carrying the kind and (for contradiction/update) the existing entry's id.

Public surface: an async function returning a typed `Decision`.

Acceptance.

- Unit tests with a seeded index: a candidate matching an existing entry within threshold triggers classification.
- Below-threshold candidate returns `fresh` without calling the classify model.
- All three classifier outcomes parsed correctly into the typed `Decision`.
- Embedding failure: returns `fresh` with a logged degradation (per the architecture's failure mode).
- Classifier failure: returns `fresh` with a logged degradation.

Open. Whether to classify against all above-threshold candidates or just the top one. Phase 3 starts with the top one; the others rarely matter at 0.85 and above. Revisit if phase 5 evals show contradictions getting missed.

---

## T04: ingest pipeline with aging and retrieve stub

Depends on: T01, T02, T03

Scope. Three small modules under `app/memory/`:

- `ingest.py`: orchestrator. Subscribes to `TurnEnd`. For each `ExtractedFact` returned by `extract`:
  1. Call `contradict.classify(fact)`.
  2. Acquire the phase-1 vault lock.
  3. Write or update the memory file at `vault/memory/{name}.md` with Skills-spec frontmatter (top-level `name` and `description`, all phase-3 fields under `metadata.*`).
  4. Insert or update the row in `entries`, `entries_vec`, `entries_fts` within one SQLite transaction.
  5. For supersession: also rewrite the superseded file's frontmatter (`metadata.supersedes_by`) and update its `entries` row.
  6. Release the lock.
  7. Run aging (`age.check_and_evict`).
  8. Emit a Logfire span.
- `age.py`: aging logic. `check_and_evict()` sums hot-tier `description_tokens`; if over `MEMORY_HOT_TOKENS`, evicts the entry with the oldest `last_referenced_at` (tie on `created_at`). Skips entries with `always: true`. Rewrites the file and the index row inside the vault lock. Loops until under budget.
- `retrieve.py`: cold-tier retrieval stub. Same shape as `app/recall/retrieve.py` but targets `memory.db` filtered to `tier: cold`. Not invoked from the chat loop at phase 3; exists for phase 7+ to adopt without redesign.

Public surface for ingest: an async event-bus subscriber registered against `TurnEnd`. Runs as a background task; does not block the event handler.

Acceptance.

- Unit tests with synthetic `TurnEnd` events and a temp vault plus temp memory.db: facts land in both stores; `entries` reflects the row.
- Supersession test: a second fact contradicting the first marks both files appropriately and tier-shifts the original.
- Aging test: insert facts until over budget; verify the oldest-`last_referenced_at` entry demotes to cold; budget is honored after eviction.
- Always-flag test: an entry with `always: true` is never selected for eviction even when oldest.
- Concurrent-write test: two ingests in parallel serialize through the lock; both complete; index reflects both.
- Retrieve stub: returns a list given a query against the cold subset (smoke-level test only; full coverage waits for phase 7).

Open. Eviction batching when many facts arrive at once: per-fact or one pass at the end. Default to per-fact (keeps the budget tight per write); revisit if eviction churn shows up in traces.

---

## T05: memory injection callback and chat-loop wiring

Depends on: T01

Scope. Two modifications.

`app/memory/inject.py` (new). The hot-tier system-prompt callback. Per turn:

1. Embed the current user message via the phase-2 embeddings wrapper.
2. Query `entries_vec` for the top `N` hot descriptions by relevance, where `N = 4 * MEMORY_HOT_TOKENS / avg_description_tokens` (use a configurable estimate of avg, default 30 tokens).
3. Always-include any entry with `metadata.always: true`.
4. Greedy pack by relevance until adding the next description would exceed `MEMORY_HOT_TOKENS`.
5. Render as a markdown fragment with an `## Operator memory` heading and one bullet per packed entry (description text).
6. Schedule `last_referenced_at` updates for injected entries as a background task post-turn (do not block injection latency).

`app/chat/loop.py` (modified). Register the memory callback as the first `@agent.system_prompt` after the base prompt; the existing phase-2 recall callback follows. Both registered at startup; pydantic-ai stacks them in registration order.

`app/main.py` (modified). At startup: open `memory.db` (T01), run the sweep (T06), subscribe `ingest` (T04) to the event bus. At shutdown: close the memory connection.

Acceptance.

- Manual smoke: with a populated memory and a relevant query, the system prompt for the turn includes the operator-memory section above the recall section (visible in Logfire trace).
- Empty-memory smoke: with an empty memory, no operator-memory section appears; recall still works.
- Budget test: a memory state where summed descriptions exceed the budget renders exactly under-budget after packing.
- Always-flag test: an `always: true` entry appears in the rendered fragment regardless of relevance score.
- `last_referenced_at` update: injected entries have updated `last_referenced_at` after the turn completes (visible by inspecting the index or the file).
- No regressions in phase-1 or phase-2 smoke tests.

Open. The `RunContext` access pattern for reading the current user message inside the callback (same open question raised in phase 2 T06). The implementing session reads pydantic-ai docs and uses the idiomatic approach.

---

## T06: memory startup sweep

Depends on: T04

Scope. `app/memory/sweep.py`. Called at app startup before the chat endpoint accepts connections.

1. Scan `vault/memory/` for markdown files. Skip hidden files and the `_staging` directory (phase-1 convention).
2. For each file: parse frontmatter, hash content.
3. Compare to `entries.content_hash`:
   - New file (no matching `name`): index it via the same write path as `ingest`, minus the contradiction step (sweep treats files on disk as authoritative).
   - Changed file (hash differs): update the row.
   - Unchanged file (hash matches): skip.
4. For each `entries` row whose `file_path` no longer exists on disk: remove from `entries`, `entries_vec`, `entries_fts`. Log the removal.
5. Refuse to run if `EMBEDDING_MODEL` differs from `_meta.last_embedding_model`. Direct the operator to `assistant memory rebuild`.

Aging is not part of sweep; sweep brings the index in sync with the vault, nothing more. The next ingest's aging cycle handles budget if sweep brought in many entries.

Acceptance.

- Fresh-vault test: populate `vault/memory/` with 5 valid files, run sweep against an empty index. All 5 are indexed.
- Delta test: 3 of 5 already indexed and unchanged; one changed; one deleted. Sweep updates the changed row and removes the orphan; the two unchanged are no-ops.
- Corrupted-file test: a file with malformed frontmatter is logged and skipped; the operator's file stays on disk; the index is unchanged for that name.
- Model-mismatch test: `EMBEDDING_MODEL` differs from the index's recorded model; sweep raises with the expected error message.

Open. None.

---

## T07: memory CLI subcommands

Depends on: T01, T04, T06

Scope. Six subcommands wired into the existing `assistant` CLI:

- `assistant memory status`: print hot/cold/superseded counts, current hot token usage versus budget, last sweep time. Read-only.
- `assistant memory show {name}`: print the file's frontmatter and body.
- `assistant memory promote {name}`: set `metadata.tier: hot` and the index row; rewrite the file. Runs aging immediately afterward in case the promotion put the budget over.
- `assistant memory demote {name}`: set `metadata.tier: cold` and the index row; rewrite the file.
- `assistant memory rebalance`: call `age.check_and_evict()` against current state.
- `assistant memory rebuild`: drop `entries`, `entries_vec`, `entries_fts`, clear `_meta.last_embedding_model`, run sweep against `vault/memory/`. Prompts for confirmation unless `--yes`.

Acceptance.

- `status` against a populated memory shows correct counts and budget usage.
- `show {name}` prints the expected file content; non-existent name yields a clear error.
- `promote` and `demote` round-trip: tier change persists, aging fires when promotion pushes over budget.
- `rebalance` evicts as expected.
- `rebuild` requires confirmation unless `--yes`; final state matches a freshly-swept vault.

Open. Whether `promote` and `demote` accept multiple names in one call. Default to single-name for phase 3; multi-name is a quality-of-life add for later.

---

## T08: integration tests (extraction, contradiction, aging, injection)

Depends on: T05, T06

Scope. `tests/integration/test_memory.py`. End-to-end tests against a real FastAPI test client, a temp vault, and a temp memory.db.

Tests:

- Extraction round-trip: complete a chat turn with a planted user statement; verify a memory file appears in `vault/memory/` and a row in `entries` after `TurnEnd`. Use a deterministic fake `direct.model_request` provider (returns the planted fact) for reproducibility.
- Cross-session recall: write a fact in session A; start session B; query something relevant; verify the operator-memory section in B's system prompt contains the fact.
- Contradiction resolution: plant fact "operator's manager is Mark". Send a new turn that triggers extraction of "operator's manager is Kin Chau". Verify the new file is written, the old file is marked `supersedes_by`, the new file marks `supersedes`, both index rows reflect the relationship, the old entry's tier is now cold.
- Budget enforcement: configure `MEMORY_HOT_TOKENS` very small (e.g., 100). Ingest 5 facts. Verify hot-tier total stays under 100; oldest entries demoted.
- Always-flag persistence: set `metadata.always: true` on an entry; ingest enough new facts to overflow the budget; verify the always-entry is not evicted.
- Sweep-on-restart: operator edits a memory file in `vault/memory/` directly (simulated by the test writing to disk); restart the test app; verify the sweep ingests the change.
- Embedding-provider degradation: configure embeddings to raise; verify ingest still writes the file but skips contradiction detection; verify injection returns empty.
- Embedding-model-change refusal: pre-seed `_meta.last_embedding_model` to a different value; verify startup sweep refuses.

Acceptance. All tests pass on CI. No flakiness across 10 consecutive CI runs.

Open. The fake `direct.model_request` provider. Same pattern as the phase-2 fake embedding provider (deterministic, no API calls). One optional test runs the real model behind `REAL_LLM=1`.

---

## T09: eval fixtures (planted-fact, contradiction, budget, aging)

Depends on: T05, T06

Scope. Add `vault/evals/phase-3/` with four buckets:

- `planted-fact-recall/`: bootstrapped pairs (planted fact, subsequent query, expected presence-in-system-prompt). Verifiable. A small standalone runner injects the fact into a fresh memory and confirms the next turn's system prompt contains it.
- `contradiction-resolution/`: fixture pairs (old fact, new fact, expected decision). Verifiable for the supersession protocol; rubric-based for the classification call (judge whether the model's classification matches the labeled expectation).
- `budget-enforcement/`: synthetic memory states with measured token counts; verify the packing algorithm respects `MEMORY_HOT_TOKENS` exactly. Pure unit-style fixtures; no model calls.
- `aging-correctness/`: synthetic memory states with measured `last_referenced_at` values; verify aging evicts the expected entry. Pure unit-style fixtures.

Acceptance.

- All four buckets load with the phase-1 fixture format.
- The three verifiable buckets can be scored by a small standalone runner (placeholder until phase 5 builds the real harness).
- Contradiction-resolution's rubric-based slice has 30 to 50 fixtures per the phase-1 design note.

Open. None.

---

## T10: docs (ADR-015 through ADR-021, CHANGELOG, NOTES.md)

Depends on: T01, T03, T04, T05 (decisions need implementations before being documented)

Scope.

- ADR-015: memory index placement (parallel `memory.db`).
- ADR-016: tier organization on disk (single folder + `metadata.tier`).
- ADR-017: aging policy (LRU, hot to cold only, no auto-promotion).
- ADR-018: contradiction handling (threshold 0.85 + classify).
- ADR-019: injection order (base, memory, recall).
- ADR-020: extraction trigger and scope (one call per `TurnEnd`, 0 to N facts; the exact prompt text lives in the ADR appendix).
- ADR-021: always-loaded entries (`metadata.always` escape hatch).
- CHANGELOG entry under `## [unreleased]`; promote to a version on merge.
- NOTES.md section titled "Phase 3: declarative memory." Explains the one concept this phase teaches: Skills-spec format as the common vault contract, with hot/cold injection as the application-layer policy on top. Cross-references the cline Memory Bank and AGENTS.md conventions that informed the design.

Acceptance.

- All seven ADRs present in `docs/adr/`.
- ADR-020 includes the exact extraction prompt text as committed in T02.
- CHANGELOG and NOTES.md updated.
- README's "what's here" section mentions declarative memory.

Open. None.
