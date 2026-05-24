---
title: plan · phase 4 · feat/skills
phase: 4
branch: feat/skills
references:
  - phase-4-brief.md
  - phase-4-architecture.md
---

# PLAN: phase 4 · feat/skills

Ten tasks. Execute roughly in order; the depends-on field shows actual blocking constraints. Each task is one focused Claude Code session.

## Status

- [ ] T01: SQLite skills index module (schema, connection, migrations)
- [ ] T02: skills loader (file and directory layouts, frontmatter parsing)
- [ ] T03: skills ingest (embed, write, idempotent)
- [ ] T04: skills startup sweep
- [ ] T05: watchdog observer with polling fallback
- [ ] T06: matching, packing, injection callback, chat-loop wiring
- [ ] T07: skills CLI subcommands
- [ ] T08: integration tests (sweep, hot-reload, matching, injection)
- [ ] T09: eval fixtures (skill-match precision, skill-following adherence)
- [ ] T10: docs (ADR-022 through ADR-028, CHANGELOG, NOTES.md)

---

## T01: SQLite skills index module (schema, connection, migrations)

Depends on: none

Scope. Create `app/skills/index.py`. Owns the SQLite connection at `{INDEX_ROOT}/skills.db` (or `SKILLS_DB_PATH` if set), loads the sqlite-vec extension, creates the schema, runs idempotent migrations.

Schema:

- `_meta`: schema_version (int), last_embedding_model (string).
- `skills`: skill_id (pk autoincrement), name (unique not null), file_path, layout (`file` or `directory`), description, body, description_tokens (int), body_tokens (int), created_at, last_updated_at, last_referenced_at, source (`user-written` | `agent-written` | `vendored`), priority (int default 0), always (bool default 0), tags (json array as text), embedding_model, content_hash.
- `skills_vec`: sqlite-vec virtual table, embedding dim configurable at schema creation (default 1536).
- `skills_fts`: FTS5 virtual table over `description` and `body`.

Public surface: open, run migrations, expose the connection.

Acceptance.

- Unit tests: fresh database creation with all tables and columns.
- Migration test: bump schema_version, verify upgrade and persistence.
- sqlite-vec and FTS5 loads succeed; failures produce clear errors.
- Schema is independent of memory and recall (distinct table names, distinct file path).

Open. None.

---

## T02: skills loader (file and directory layouts, frontmatter parsing)

Depends on: none

Scope. `app/skills/loader.py`. Two responsibilities.

First, discovery: walk `vault/skills/` and emit one record per skill regardless of layout.

- File layout: `vault/skills/{name}.md` where the basename matches the `name` frontmatter.
- Directory layout: `vault/skills/{name}/SKILL.md` where the parent directory name matches the `name` frontmatter.
- Hidden files and entries named `_staging` are skipped (phase-1 convention).
- Mismatch between filename / parent-directory and frontmatter `name` is a structured warning; the record is emitted with the frontmatter `name` as authoritative.

Second, parsing: read each discovered skill into a typed `SkillRecord`:

- Required: `name`, `description`, `metadata.source`, `metadata.created_at`, `metadata.last_updated_at`. Missing required field is a parse error.
- Optional: `metadata.priority` (default 0), `metadata.always` (default false), `metadata.tags` (default empty list), `metadata.last_referenced_at` (default = created_at), `metadata.embedding_model`.
- Body: everything after the frontmatter, verbatim.
- Compute `content_hash` (SHA-256 of the file or, for directory layout, of the SKILL.md alone; references and scripts are not hashed).

Public surface: an iterator function over `vault/skills/` yielding `(SkillRecord | LoadError, file_path)`. Errors are returned, not raised; the caller decides whether to log and continue.

Acceptance.

- Unit tests for both layouts against fixtures.
- Mismatched name test: filename and frontmatter `name` disagree; record emitted with frontmatter authoritative; warning logged.
- Missing-required-field test: returns a `LoadError`, not a raise.
- Multi-file skill with `references/` and `scripts/` siblings: loader emits the SKILL.md record only; references and scripts are not opened.
- Tags as a list parse correctly; missing tags default to empty list.

Open. Whether to enforce that single-file skills' frontmatter `name` matches the filename. The loader is permissive (frontmatter wins, warning logged); if you prefer strict, T02 changes to raise.

---

## T03: skills ingest (embed, write, idempotent)

Depends on: T01, T02

Scope. `app/skills/ingest.py`. Given one `SkillRecord`:

1. Compare the `content_hash` against the existing row (if any). If unchanged AND `embedding_model` matches, return early; no work.
2. Otherwise, embed the description via the phase-2 embeddings wrapper.
3. Compute token counts for description and body using a tokenizer consistent with the model strings used.
4. Write to `skills`, `skills_vec`, `skills_fts` in one SQLite transaction. Carry the current `EMBEDDING_MODEL`.
5. Emit a Logfire span: skill name, body tokens, embedding tokens, latency, action (`insert`, `update`, `skip`).

Failure handling:

- Embedding provider error: exponential backoff (3 attempts). On final failure, leave the previous index row in place (do not delete or partially-write) and log a structured warning. Matching for that skill degrades to FTS5-only on stale embeddings until the next successful ingest.
- SQLite write error: roll back; log.

Public surface: an async function taking a `SkillRecord` and returning a `IngestResult` (action taken, hash before, hash after).

Acceptance.

- Unit tests: insert, update, skip paths each tested against a temp index.
- Idempotency: re-ingesting an unchanged skill is a no-op (and returns `skip`).
- Embedding-failure test: provider raises; result is logged; existing row unchanged.
- Body-tokens recorded matches a fresh tokenization of the body.

Open. The tokenizer choice. `tiktoken` for OpenAI models is the obvious default. Document the choice; if the embedding-model change forces a different tokenizer (e.g. for a future Voyage model), it becomes a config detail.

---

## T04: skills startup sweep

Depends on: T02, T03

Scope. `app/skills/sweep.py`. Called at startup before chat accepts connections.

1. Refuse to run if `EMBEDDING_MODEL` differs from `_meta.last_embedding_model`. Direct the operator to `assistant skills rebuild`.
2. Iterate `loader` over `vault/skills/`. For each record: call ingest.
3. After the walk, find rows in `skills` whose `file_path` no longer points to an existing file. Delete those rows from `skills`, `skills_vec`, `skills_fts`. Log each removal.
4. Log a summary: count inserted, updated, skipped, removed, failed.

Acceptance.

- Fresh-vault test: 5 skill files; empty index. Sweep ingests all 5.
- Delta test: 3 unchanged, 1 changed, 1 deleted, 1 new. Sweep produces 1 skip, 1 update, 1 remove, 1 insert.
- Embedding-model mismatch raises with the rebuild instruction.
- Concurrent skill-file edit during sweep: the next sweep cycle or watcher event catches it; the current sweep does not partial-write.

Open. None.

---

## T05: watchdog observer with polling fallback

Depends on: T03, T04

Scope. `app/skills/watcher.py`. Two paths.

`watchdog` path (preferred):

1. Use `watchdog.observers.Observer` against `vault/skills/`. Subscribe a handler that batches events into a debounce queue keyed by file path with a 500 ms debounce window.
2. For each debounced event:
   - Created or modified: read the file, run loader to produce a `SkillRecord`, call ingest. Skip if the path is hidden or under `_staging`.
   - Deleted: delete the matching row from `skills`, `skills_vec`, `skills_fts` by `file_path`.
   - Moved: treat as delete-then-create.
3. Start the observer in a background thread (watchdog's native pattern); communicate to the asyncio loop via a thread-safe queue.

Polling fallback:

1. If watchdog's observer fails to start (e.g., FSEvents unavailable, inotify limits hit), log a clear notice and switch to polling.
2. Polling runs the same sweep logic as T04 every `SKILL_POLL_INTERVAL` (default 10 seconds).
3. The fallback decision is logged once at startup; subsequent runs do not re-log.

Public surface: a `start()` and `stop()` pair. `start()` returns after the observer is running; `stop()` joins the background thread cleanly.

Acceptance.

- Manual smoke: with the app running, edit a skill file; verify the change reflects in `assistant skills show {name}` within a few seconds.
- Manual smoke: create a new skill file; verify it appears in `assistant skills status`.
- Manual smoke: delete a skill file; verify it disappears from status.
- Manual smoke: rename a skill file; verify the row is removed under the old name and inserted under the new.
- Debounce test: rapid saves of the same file within 500 ms result in one ingest call.
- Fallback test: simulate watchdog start failure; verify the polling path takes over (test on a mock or by raising in the observer's start).
- Shutdown test: `stop()` returns within a small bound; the background thread joins.

Open. Whether to recursively watch the vault root or only `vault/skills/`. Limit to `vault/skills/`; recursive watching is cheap but invites surprises (e.g., reacting to phase-1 transcript writes).

---

## T06: matching, packing, injection callback, chat-loop wiring

Depends on: T01, T03

Scope. Four modules and one chat-loop modification.

`app/skills/match.py` (new). Per-turn matching:

1. Embed the user message via the phase-2 embeddings wrapper.
2. KNN over `skills_vec` (LIMIT `2 * (SKILL_BUDGET / avg_body_tokens)`, with `avg_body_tokens` defaulting to 400).
3. FTS5 BM25 against `skills_fts` over the same query.
4. Fuse via RRF (constant 60).
5. Filter to candidates above `SKILL_MATCH_THRESHOLD` (default 0.55).
6. Sort by fused score descending; ties broken by `metadata.priority` descending, then by name.
7. Return a `MatchResult` carrying the ranked candidates and per-branch scores (for trace and eval visibility).

`app/skills/pack.py` (new). Greedy packer:

1. Take all `always: true` candidates first; reserve their body tokens.
2. Iterate the rest in order. For each, include if `current_total + body_tokens <= SKILL_BUDGET`. Otherwise skip.
3. Return the packed list in similarity order. If `always` skills alone exceed the budget, include them anyway and log a warning.

`app/skills/inject.py` (new). The `@agent.system_prompt` callback:

1. Call `match.match()` with the current user message.
2. Call `pack.pack()` with the candidate list and `SKILL_BUDGET`.
3. Render the system-prompt fragment as the architecture specifies (`## Skills for this turn` heading, one `### {name}` subsection per packed skill with the body verbatim).
4. Schedule `last_referenced_at` updates for injected skills as a background task post-turn.

`app/chat/loop.py` (modified). Register the skills callback as the second `@agent.system_prompt`. The final order: base prompt, memory hot tier (phase 3), skills (this), recall (phase 2). This supersedes ADR-019's order from phase 3; ADR-024 captures the change.

`app/main.py` (modified). At startup, after `skills.sweep.run()`: register the skills callback and start the watcher (T05). At shutdown: stop the watcher.

Acceptance.

- Manual smoke: with a populated catalog and a relevant query, the system prompt for the turn includes the skills section above the recall section and below the memory section (visible in Logfire trace).
- Empty-catalog smoke: no skills indexed; no skills section appears; chat continues.
- Threshold test: with a deliberately-irrelevant query against a populated catalog, no skills above threshold are selected; the section is empty or absent.
- Always-flag test: an `always: true` skill appears regardless of relevance.
- Budget test: catalog whose matched-skills' bodies exceed the budget renders exactly under-budget after packing.
- `last_referenced_at` updates: rows reflect updated `last_referenced_at` after the turn.
- No regressions in phases 1, 2, 3 smoke tests.

Open. The `RunContext` access pattern for reading the current user message (same open question as phase 2 T06 and phase 3 T05). The implementing session uses the idiomatic pydantic-ai approach.

---

## T07: skills CLI subcommands

Depends on: T01, T03, T04, T06

Scope. Four subcommands wired into the `assistant` CLI.

- `assistant skills status`: print one line per skill (name, source, priority, body tokens, always flag, last_referenced_at). Footer: total skill count, count by source, count by always-flag, current `SKILL_BUDGET`, total tokens occupied by always-flagged skills.
- `assistant skills show {name}`: print frontmatter and body of the skill matching that name.
- `assistant skills test {query}`: run `match.match(query)` against the live index; print the candidate list with scores per branch (vec, BM25, fused); print the threshold filter cut; print the packed result.
- `assistant skills rebuild`: drop and rebuild the index from `vault/skills/`. Confirmation required unless `--yes`. A `--dry-run` flag prints the plan without executing.

Acceptance.

- `status`: outputs the expected rows for a populated catalog; counts are accurate.
- `show {name}`: prints expected content; missing name yields a clear error.
- `test "query string"`: outputs candidates with scores and the packed result; runs without modifying state.
- `rebuild`: produces an empty-then-full state; `--dry-run` does not modify the index.

Open. Whether `test` should output Logfire spans or just print to stdout. Default to print-only for the CLI; Logfire still fires inside `match.match()` itself.

---

## T08: integration tests (sweep, hot-reload, matching, injection)

Depends on: T05, T06, T07

Scope. `tests/integration/test_skills.py`. End-to-end against a real FastAPI test client, temp vault, temp `INDEX_ROOT`.

Tests:

- Sweep on startup: populate `vault/skills/` with 3 single-file skills and 1 directory-layout skill. Start the app. Verify all 4 land in the index.
- Hot-reload create: app running; write a new skill file. Wait for debounce + ingest. Verify the new skill appears in `assistant skills status` and matches against a relevant query.
- Hot-reload modify: app running; modify an existing skill's body. Verify the body updates in the index; next turn injects the new body.
- Hot-reload delete: app running; remove a skill file. Verify the row is gone.
- Multi-file layout: write `vault/skills/dossier-build/SKILL.md` with references and scripts siblings. Verify the SKILL.md content indexes; references and scripts paths are not opened.
- Matching with injection: pre-seed a skill; send a chat turn whose user message matches the description; verify the system prompt for the turn contains the skill's body in the skills section.
- Threshold filter: send a chat turn whose user message is unrelated to any skill; verify no skills section appears.
- Always-flag: a skill flagged `always: true` appears in every turn's system prompt.
- Budget enforcement: configure `SKILL_BUDGET` to a small value; seed several skills with large bodies; verify only the highest-ranked subset that fits is injected.
- Watchdog fallback: simulate the observer's `start()` failing; verify the polling path takes over; create a file; verify it indexes within `SKILL_POLL_INTERVAL` plus headroom.
- Embedding-model-change refusal: pre-seed a different `_meta.last_embedding_model`; verify startup sweep refuses with the rebuild instruction.

Acceptance. All tests pass on CI. No flakiness across 10 consecutive CI runs. Hot-reload tests use small explicit waits (debounce + slack) rather than busy-waits.

Open. The deterministic fake embedding provider for CI (same pattern as phase 2 and 3). Real embeddings behind `REAL_EMBEDDINGS=1`.

---

## T09: eval fixtures (skill-match precision, skill-following adherence)

Depends on: T06, T07

Scope. Add `vault/evals/phase-4/` with two buckets.

`skill-match-precision/`: bootstrapped (query, expected-skill-name) pairs. Format: one fixture per pair with frontmatter carrying `query`, `expected_skill_name`. Verifiable. A standalone runner invokes `match.match(query)` against the live index and scores whether `expected_skill_name` is in the packed result at position 1 (precision@1) and within the packed set (precision@k for the budgeted k).

`skill-following-adherence/`: a handful of (skill, query, expected-rubric) triples. The runner sends the query through the chat loop with the skill injected; the response is judged against the rubric via LLM-as-judge. Rubric expresses what "following the skill" looks like for that combination (e.g. "the response should produce a numbered list of findings" for code-review).

Acceptance.

- Both buckets load with the phase-1 fixture format.
- `skill-match-precision/` has 30 to 50 fixtures (phase-1 design note for judge slice sizing applies to verifiable buckets too, for similar reasons of statistical noise).
- `skill-following-adherence/` has at least one fixture per skill in the curated catalog, with the rubric committed.
- A standalone runner scores `skill-match-precision/` against the current index; outputs precision@1 and precision@budget.
- Full phase-5 harness will subsume both buckets when it lands.

Open. Whether `skill-following-adherence/` rubric judging happens at phase 4 (with a placeholder LLM-as-judge runner) or waits for phase 5. Default to fixtures-only at phase 4; the runner is a phase-5 deliverable.

---

## T10: docs (ADR-022 through ADR-028, CHANGELOG, NOTES.md)

Depends on: T01, T03, T05, T06 (decisions need implementations before being documented)

Scope.

- ADR-022: skills store placement (parallel `skills.db`).
- ADR-023: matching algorithm (hybrid vec + BM25 with RRF, threshold filtered).
- ADR-024: injection order (memory, skills, recall). Supersedes ADR-019.
- ADR-025: budget and packing (greedy, no truncation, always-skills reserved first).
- ADR-026: descriptions are not always-loaded (deviation from Anthropic Agent Skills tier-1 intent, with rationale).
- ADR-027: hot-reload mechanism (watchdog with 500 ms debounce; polling fallback at `SKILL_POLL_INTERVAL`).
- ADR-028: references and scripts are present-but-deferred (loaded by tools in phases 6 and 7).
- CHANGELOG entry under `## [unreleased]`; promote on merge.
- NOTES.md section titled "Phase 4: skills catalog." Explains the one concept this phase teaches: the Skills-spec format used the way it was intended (one entry per file, description-driven matching), with a hot-reload watcher giving the operator iterative authoring without restart cycles. Cross-references the kepano/obsidian-skills format target and the Anthropic Agent Skills spec.

Acceptance.

- All seven ADRs present in `docs/adr/`.
- ADR-024 explicitly notes that it supersedes ADR-019.
- ADR-026 captures the deviation from spec intent so future contributors (or the operator returning to the code in six months) understand the tradeoff.
- CHANGELOG and NOTES.md updated.
- README's "what's here" section mentions skills.

Open. Whether to add a small one-page "authoring a skill" guide alongside the NOTES section, given the operator is the only skill author at phase 4. Defer; revisit if the catalog grows large or someone else starts authoring.
