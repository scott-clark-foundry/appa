---
title: plan · phase 5 · feat/eval-harness
phase: 5
branch: feat/eval-harness
references:
  - phase-5-brief.md
  - phase-5-architecture.md
---

# PLAN: phase 5 · feat/eval-harness

Ten tasks. Execute roughly in order; the depends-on field shows actual blocking constraints. Each task is one focused Claude Code session.

## Status

- [ ] T01: fixture format spec and loader
- [ ] T02: results store (`evals.db`)
- [ ] T03: scorers (verifiable + judge with diskcache)
- [ ] T04: per-phase runners for phases 1 and 2
- [ ] T05: per-phase runners for phases 3 and 4
- [ ] T06: orchestrator (`run.py`) with summary writer
- [ ] T07: label and validate workflows
- [ ] T08: comparison view and CLI top-level
- [ ] T09: integration tests
- [ ] T10: docs (ADR-029 through ADR-036, CHANGELOG, NOTES.md)

---

## T01: fixture format spec and loader

Depends on: none

Scope. Two modules.

`app/evals/format.py`: typed pydantic models per fixture `type`. A common `FixtureBase` carries `name`, `description`, `metadata.phase`, `metadata.bucket`, `metadata.type`, `metadata.expected`, plus optional `metadata.human_score`, `metadata.human_reasoning`, `metadata.human_labeled_at`, `metadata.human_labeled_by`, `metadata.rubric_ref`. Four subclasses for the four types (`VerifiableSingle`, `VerifiableStateful`, `RubricSingle`, `RubricMultiTurn`), each typing the `expected` field appropriately.

`app/evals/loader.py`:

1. `load_bucket(phase, bucket)`: walks `vault/evals/phase-{phase}/{bucket}/` and yields `(FixtureRecord | LoadError, file_path)`.
2. `load_phase(phase)`: walks all buckets under `vault/evals/phase-{phase}/`.
3. `load_rubric(rubric_ref)`: reads `vault/evals/_rubrics/{ref}.md`, returns a `RubricRecord` with `score_kind`, body (the rubric text), optional `agreement_metric` override.
4. Inline rubric in a fixture's body overrides `rubric_ref` resolution; the loader surfaces both.

Discovery skips hidden files and `_staging`, `_rubrics`, `_runs`.

Acceptance.

- Unit tests for each of the four fixture types against committed fixtures from phases 1-4.
- Missing required `metadata.*` field returns a `LoadError`, not a raise.
- `rubric_ref` resolution: a fixture with `metadata.rubric_ref: coherence-5pt` loads `vault/evals/_rubrics/coherence-5pt.md`.
- Inline rubric in a fixture body takes precedence over `rubric_ref`.
- Iterator returns errors mixed with records (caller decides whether to log).

Open. Whether to support glob patterns at the loader API (`load("phase-2/recall-*")`). Defer to T08's CLI layer; loader stays simple.

---

## T02: results store

Depends on: none

Scope. `app/evals/store.py`. SQLite at `{INDEX_ROOT}/evals.db` (or `EVALS_DB_PATH`). Owns the connection, schema, migrations.

Schema:

- `_meta`: schema_version.
- `runs`: run_id (pk autoincrement), label (not null), started_at, ended_at, status (`running`, `completed`, `interrupted`, `failed`), config_snapshot (JSON text), git_sha, total_fixtures, passed, failed, errored, judge_calls, judge_cache_hits.
- `fixture_results`: result_id (pk autoincrement), run_id (fk), fixture_path, phase, bucket, type, score (real), pass (bool), human_score (real), judge_reasoning (text), judge_confidence (real), judge_model (text), rubric_hash (text), latency_ms (int), cost_usd (real), cached (bool), error (text).
- Indexes: `runs(label, started_at)`, `fixture_results(run_id)`, `fixture_results(run_id, phase, bucket)`.

Public API:

- `open(db_path) -> Store`: open and migrate.
- `start_run(label, config_snapshot, git_sha) -> run_id`: insert a row with `status: running`.
- `record_result(run_id, fixture_path, ..., ...)`: insert a fixture_results row.
- `complete_run(run_id, status, totals)`: update the runs row.
- `get_run(run_id) -> Run`, `get_run_by_label(label) -> Run`, `list_runs(...) -> [Run]`.
- `get_results(run_id, phase=None, bucket=None) -> [Result]`.
- `prune_runs(keep_last) -> int`: delete the oldest runs leaving `keep_last`.

In-process lock: a module-level `threading.Lock` or `asyncio.Lock` serializes writes. Concurrent runs against the same store are not supported in phase 5; a second process attempting `start_run` while another holds the lock fails fast with a clear error.

Acceptance.

- Unit tests: schema creation, migration, basic CRUD against a temp database.
- `start_run` followed by `complete_run` updates the row correctly; totals match the count of inserted `fixture_results`.
- `prune_runs(keep_last=5)` against 10 runs deletes 5 oldest and cascades to their results.
- Concurrent `start_run` raises a clear error rather than corrupting state.

Open. Whether `prune_runs` requires `--yes` confirmation. CLI-layer concern, not store layer; T08 decides.

---

## T03: scorers (verifiable + judge with diskcache)

Depends on: T01

Scope. Three modules under `app/evals/scorers/`.

`verifiable.py`. Pure-Python comparison logic. Functions:

- `score_verifiable_single(fixture, actual) -> VerifiableScore`: dispatches on `expected.score_kind`. Supports `equal`, `contains`, `contains_substring`, `contains_in_top_k`, `subset`, `superset`, `mrr_rank`. Returns score (0 or 1, or real-valued for `mrr_rank`) and a structured `reason` field.
- `score_verifiable_stateful(fixture, post_state) -> VerifiableScore`: compares the post-state of the capability (e.g., memory tier assignments) against `expected`. Field-by-field equality, with order-insensitive list comparison if `expected.unordered` is true.

`cache.py`. Diskcache wrapper at `{INDEX_ROOT}/evals_cache/` (or `EVALS_CACHE_PATH`).

- `compute_key(judge_model, rubric_text, payload) -> str`: `sha256(judge_model || rubric_text || json.dumps(payload, sort_keys=True))`.
- `get_or_compute(key, fn) -> (value, cached_bool)`: cache lookup; on miss, await `fn()`, store, return.
- Logfire span per call carrying `cache_key`, `cached`, `latency_ms`.

`judge.py`. LLM-as-judge.

- `JudgeVerdict` pydantic model: `score` (float or int per rubric `score_kind`), `reasoning` (str), `confidence` (float 0..1).
- `score_judge(fixture, captured) -> JudgeScore`:
  1. Resolves the rubric (inline > ref via loader).
  2. Constructs the judge prompt: system message with the rubric and a schema-aware instruction; user message with the fixture's `input` and the captured output.
  3. Builds the cache key (per `cache.compute_key`).
  4. `get_or_compute` wraps a `direct.model_request` call that returns `JudgeVerdict`.
  5. Returns `JudgeScore` carrying `score`, `reasoning`, `confidence`, `cached`, `rubric_hash`, `latency_ms`, `cost_usd_estimate`.

`__init__.py` exposes a dispatch function `score(fixture, captured) -> ScoreResult` that branches on fixture type and returns a unified result.

Acceptance.

- Unit tests for `verifiable.py`: each `score_kind` against committed phase-1 through phase-3 verifiable fixtures.
- Cache test: identical inputs produce a cache hit; changing the rubric text produces a miss; changing the judge model produces a miss; changing `expected` does NOT produce a miss.
- Judge test against a fake `direct.model_request`: produces a `JudgeScore` matching the fake's verdict.
- Judge test for ordinal score: returns an integer, not a float.
- Logfire spans emitted with the documented fields.

Open. Whether to include `confidence` in the cache key. No: the judge's self-reported confidence is a function of the same inputs as `score`; including it would never differ between cache hits.

---

## T04: per-phase runners for phases 1 and 2

Depends on: T01, T02, T03

Scope. Two modules under `app/evals/runners/` plus a shared helper.

`_state.py`:

- `temp_index_root()`: context manager yielding a path; sets `INDEX_ROOT` env-var-style override; cleans up on exit.
- `seed_transcripts(records, vault_root)`: writes a list of synthetic transcript records to a temp vault and updates the phase-1 manifest.
- `inprocess_agent(config_overrides)`: constructs a pydantic-ai Agent with the same callbacks as production but with config overrides applied. Returns the Agent; the caller drives turns.

`runners/phase1.py`:

- `persistence-roundtrip`: build a synthetic session record from the fixture's input; call `app.persistence.recorder` to render and write; re-parse the resulting file; return `CaptureResult(roundtripped=record)`.
- `cancellation-marker`: simulate a turn with the fixture's `events` (including a cancellation); call the recorder; return `CaptureResult(rendered_text=...)` for the scorer to inspect.
- `multi-turn-coherence`: load the referenced transcript file; return `CaptureResult(transcript_text=...)` for the judge.

`runners/phase2.py`:

- `recall-at-k`: under `temp_index_root`, seed transcripts; ingest via `app.recall.ingest`; call `app.recall.retrieve.retrieve(query, k)`; return `CaptureResult(ranked_chunks=...)`.
- `mrr`: same setup as `recall-at-k`; scorer computes reciprocal rank from the ranked chunks.
- `faithfulness`: under `temp_index_root`, seed a single transcript with the fixture's `input.context_chunks`. Construct an `inprocess_agent` with embedding model override if specified. Send the fixture's eliciting query through the agent; capture the response. Return `CaptureResult(response_text=..., retrieved_context=...)`.

Each runner module exposes `runners: dict[str, Callable]` keyed by bucket name.

Acceptance.

- Unit tests for each runner against the fixtures shipped with phases 1 and 2.
- Round-trip parity test: verifiable buckets produce the same score the standalone runners shipped with phases 1 and 2 produced for the same fixtures. This is the regression check.
- State isolation test: running two fixtures in sequence does not leak vault content between them.
- Concurrent test: running two fixtures in parallel does not leak state.
- Faithfulness runner does not require Logfire to be configured to function (in case of dev environment skew).

Open. Whether `inprocess_agent` lives in `_state.py` or in a dedicated `app/chat/test_helpers.py`. Default to `_state.py` to keep eval-only concerns together; revisit if `inprocess_agent` grows beyond eval needs.

---

## T05: per-phase runners for phases 3 and 4

Depends on: T01, T02, T03, T04 (`_state` helpers)

Scope. Two modules.

`runners/phase3.py`:

- `planted-fact-recall`: under `temp_index_root`, seed memory with `setup.memory_entries`; call `app.memory.inject.render(query)`; return `CaptureResult(rendered_fragment=..., entries_referenced=...)`.
- `contradiction-resolution`: seed memory; invoke `app.memory.ingest.ingest_one(fact)` from the fixture's `action`; capture the post-state (current memory entries with tier and supersedes pointers). Return `CaptureResult(post_state=...)`.
- `budget-enforcement`: seed memory; apply config override `MEMORY_HOT_TOKENS`; ingest the action's fact; capture the post-state. Return `CaptureResult(post_state=...)`.
- `aging-correctness`: seed memory entries with explicit `last_referenced_at` values; call `app.memory.age.check_and_evict()`; capture the post-state.

`runners/phase4.py`:

- `skill-match-precision`: under `temp_index_root`, seed skills via direct writes plus `app.skills.sweep.run()`; call `app.skills.match.match(query)`; return `CaptureResult(ranked_candidates=...)`. The scorer checks for `expected_skill_name` at the documented positions.
- `skill-following-adherence`: seed a single-skill catalog with the fixture's skill; construct an `inprocess_agent`; send the fixture's query; capture the response. Return `CaptureResult(response_text=..., skill_body=...)` for the judge.

Helpers added to `_state.py` as needed: `seed_memory(entries, index_root)`, `seed_skills(skills, index_root)`. Each calls the phase-3 / phase-4 ingest paths directly so the resulting state is identical to what would exist if the operator had naturally accumulated those entries.

Acceptance.

- Unit tests for each runner against the fixtures shipped with phases 3 and 4.
- Round-trip parity: verifiable buckets produce the same scores as the standalone runners.
- `contradiction-resolution`: a fixture with two contradicting facts produces the expected supersedes-pointer state.
- `budget-enforcement`: a fixture with a configured small budget produces the expected hot/cold split after ingest.
- `skill-following-adherence` does not require a live network when run against the fake `direct.model_request` provider.

Open. Whether `aging-correctness` fixtures can express `last_referenced_at` deltas symbolically (`2 days ago`) or only as absolute ISO timestamps. Default to absolute (deterministic); add relative parsing later if fixtures become repetitive.

---

## T06: orchestrator (`run.py`) with summary writer

Depends on: T02, T03, T04, T05

Scope. `app/evals/run.py`.

Public API:

- `RunConfig` typed model: workers per scorer kind (`verifiable`, `judge`, `chat`), overrides (dict of capability-config keys), judge model, fixture filter (glob), label, dry-run flag.
- `async run(config: RunConfig) -> RunSummary`:
  1. Open the store; insert a `runs` row with `status: running`.
  2. Capture git SHA via `subprocess`; record in the run.
  3. Discover fixtures via the loader.
  4. Build a task queue keyed by scorer kind.
  5. Fan out concurrently per `--workers` budget.
  6. For each fixture: invoke the per-phase runner, then the scorer, then `store.record_result`.
  7. Handle interrupts (KeyboardInterrupt): commit completed fixtures, mark `status: interrupted`, return cleanly.
  8. On clean completion: mark `status: completed`, compute totals, write the human-readable summary via the phase-1 vault writer.

Summary writer: renders `vault/evals/_runs/{label}/{run_id}/summary.md` with:

- Frontmatter (run metadata, totals, judge stats).
- Rollup table per (phase, bucket): pass rate, mean score, mean judge confidence, errored count.
- Per-fixture detail rows for fixtures with `pass: false` or `error: not null`.

Acceptance.

- Unit test: a `RunConfig` against a temp vault of synthetic fixtures runs to completion, writes a row in `runs`, writes one row per fixture in `fixture_results`, writes the summary markdown.
- Interrupt test: kill the orchestrator mid-run via signal; the run is marked `interrupted`; committed fixtures persist.
- Config-override test: an override propagates to the runner (verified via a side-effect-capturing fake runner).
- Worker-cap test: requesting `--workers chat=1` serializes chat-runner invocations even when many fixtures are queued.
- Filter test: a `--filter recall-at-*` glob includes only matching buckets.
- Summary file rendered: parses as valid markdown with the documented sections.

Open. Whether to fail the whole run if more than N percent of fixtures error. Default no: report and continue. The operator decides whether to act on a partial run.

---

## T07: label and validate workflows

Depends on: T01, T03, T06

Scope. Two modules.

`app/evals/label.py`. Interactive labeling.

- `async label_bucket(phase, bucket, re_label=False, labeler=None)`:
  1. Load fixtures via the loader. Filter to those without `metadata.human_score` (or all, if `re_label=True`).
  2. For each: clear screen (`rich`'s `console.clear` or equivalent); print fixture name, the rubric (resolved inline or via ref), and the input the judge would see.
  3. Prompt for score and reasoning. Validate the score against `rubric.score_kind`.
  4. Confirm overwrite if re-labeling.
  5. Update fixture frontmatter: `metadata.human_score`, `metadata.human_reasoning`, `metadata.human_labeled_at` (current time), `metadata.human_labeled_by` (`labeler` arg, `EVALS_LABELER` env var, or `git config user.name`).
  6. Write back through the phase-1 vault writer.

`app/evals/validate.py`. Judge-human agreement.

- `async validate_bucket(phase, bucket, run_label) -> AgreementReport`:
  1. Load fixtures; filter to those with `metadata.human_score`.
  2. Refuse to run if fewer than 30 labels (warning + report continues; do not block).
  3. For each labeled fixture: invoke the per-phase runner; invoke the judge scorer; collect `(human_score, judge_score)` pairs.
  4. Compute the agreement metric per rubric `agreement_metric` (binary → accuracy; ordinal → Cohen's quadratic-weighted kappa; continuous → Spearman ρ + mean absolute error).
  5. Build `AgreementReport`: metric value, sample size, distribution of disagreements, list of disagreement details (top-N by absolute delta).
  6. Write `vault/evals/_runs/{run_label}/{run_id}/validation/{phase}-{bucket}.md` through the phase-1 vault writer.

Acceptance.

- Label workflow: a fixture without `human_score` walks through prompts; the resulting file has the four labeled fields; `human_labeled_at` is a valid ISO timestamp.
- Re-label workflow: prompts for overwrite confirmation; declining leaves the existing score.
- Validate workflow: against a hand-labeled bucket fixture set, the agreement metric matches a hand-computed reference.
- Validate workflow with fewer than 30 labels: warning in the report; metric still computed.
- Validate workflow with all judges agreeing perfectly: kappa is 1.0 (or accuracy 1.0, etc.).

Open. Whether `label` should also support a non-interactive mode (`--input labels.json`) for bulk labeling from a CSV. Defer; interactive is enough for 30-50 examples per bucket.

---

## T08: comparison view and CLI top-level

Depends on: T02, T06, T07

Scope. Two modules.

`app/evals/compare.py`:

- `async compare(run_label_a, run_label_b, epsilon=0.05) -> ComparisonReport`:
  1. Load both runs from the store.
  2. Join `fixture_results` on `(phase, bucket, fixture_path)`.
  3. For each pair: compute delta (score_b - score_a); flag if `|delta| > epsilon`.
  4. Render with `rich`:
     - Header: both run labels, run IDs, dates, git SHAs.
     - Bucket-rollup table: per (phase, bucket): n, pass-rate-a, pass-rate-b, delta, mean-score-a, mean-score-b, delta, count-changed.
     - Per-fixture detail table: rows where `|delta| > epsilon`; columns: phase, bucket, fixture name, score-a, score-b, delta, reasoning-a (excerpt), reasoning-b (excerpt). Green for improvement, red for regression.
- Output to stdout by default; `--save` writes to `vault/evals/_runs/_comparisons/{label_a}-vs-{label_b}.md`.

`app/evals/cli.py`. The `assistant eval` subcommand surface, dispatching to the modules above:

- `eval run [--phase N | --bucket B | --filter glob] [--label L] [--override K=V ...] [--workers ...] [--dry-run]`
- `eval compare LABEL_A LABEL_B [--epsilon X] [--save]`
- `eval validate --phase N --bucket B [--run-label L]` (defaults to the most recent completed run)
- `eval label --phase N --bucket B [--re-label]`
- `eval status [--phase N]`: list recent runs with totals; per-bucket label coverage.
- `eval prune --keep-last N [--yes]`

Acceptance.

- `compare` produces a non-empty rich-rendered table for two runs over the same fixtures.
- `compare` correctly orients deltas (b - a); reversing the arg order flips signs.
- All six subcommands parse and dispatch; `--help` is meaningful for each.
- `status` reports label coverage as `{labeled} / {total}` per bucket and warns when below 30.

Open. Whether `eval status` also shows a tiny ASCII trend of pass rate over the last N runs per bucket. Defer; pretty-print is a polish task.

---

## T09: integration tests

Depends on: T06, T07, T08

Scope. `tests/integration/test_evals.py`. End-to-end against a real CLI invocation, a temp `INDEX_ROOT`, and a temp vault seeded with a synthetic fixture set.

Tests:

- End-to-end run: invoke `eval run --phase 2 --label baseline`; verify the `runs` row, the `fixture_results` rows, the `_runs/baseline/{run_id}/summary.md` file.
- Cache reuse: run the same `eval run` twice; the second run shows `judge_cache_hits > 0`.
- Override: invoke with `--override RECALL_TOP_K=7`; verify the snapshot reflects the override and the underlying runner sees it.
- Interrupt-and-resume: signal interrupt mid-run; verify the run is marked `interrupted` and partial results persist.
- Compare: run `--label a`, then `--label b` with an override that changes results; `eval compare a b` shows a non-trivial delta table.
- Label round-trip: invoke `eval label --phase 2 --bucket faithfulness` against an unlabeled fixture; pipe in a score and reasoning; verify the fixture frontmatter is updated.
- Validate: with a hand-prepared labeled bucket, `eval validate --phase 2 --bucket faithfulness` produces an `AgreementReport` matching the hand-computed metric.
- Prune: `eval prune --keep-last 2` against 5 runs leaves 2.
- Concurrent runs: two simultaneous `eval run` invocations: the second fails fast with a clear error.
- Parity check: for verifiable buckets in phases 1-4, harness scores match the standalone runners' scores on the same committed fixtures.

Acceptance. All tests pass on CI. No flakiness across 10 consecutive runs. Fake `direct.model_request` provider used by default; `REAL_LLM=1` opts into a slow path with real judge calls.

Open. Whether the parity check is part of CI or a one-shot run committed as a snapshot. Default to CI: it catches regressions where harness changes silently change scores.

---

## T10: docs (ADR-029 through ADR-036, CHANGELOG, NOTES.md)

Depends on: T01, T03, T06, T07, T08 (decisions need implementations first)

Scope.

- ADR-029: fixture format (four `type`s, Skills-spec-style frontmatter, fixtures not Skills-spec compliant).
- ADR-030: results store (SQLite, normalized).
- ADR-031: results not committed to git; per-run markdown summaries are.
- ADR-032: scorer architecture (verifiable + judge with diskcache).
- ADR-033: judge cache key (`sha256(judge_model || rubric_text || serialize(input, captured))`).
- ADR-034: rubric storage (inline overrides ref; `_rubrics/` directory; rubric hash on every score for auditability).
- ADR-035: agreement metric per rubric type (binary → accuracy; ordinal → Cohen's quadratic-weighted kappa; continuous → Spearman ρ + MAE).
- ADR-036: judge model default (`openai:gpt-4o-mini`) with the cost estimate.
- CHANGELOG entry under `## [unreleased]`; promote on merge.
- NOTES.md section titled "Phase 5: the eval pivot." Explains the one concept this phase teaches: how to evaluate an LLM app without an SME by combining verifiable mechanical tests, LLM-as-judge with operator-validated rubrics, and a diskcache that makes re-runs cheap. The validation ritual (judge-human agreement on 30-50 examples per rubric) is the discipline. Cross-references Hamel Husain's workflow (G6 in the portfolio plan), meshkovQA/Eval-ai-library as the size and shape analog, and openai/evals as the pattern reference.

Acceptance.

- All eight ADRs present in `docs/adr/`.
- ADR-036 includes a concrete cost estimate for a full phase-1-through-4 rubric pass.
- NOTES.md section explicitly connects the pieces (fixtures, runners, scorers, cache, validation) so a reader six months later can reconstruct the design.
- CHANGELOG and NOTES.md updated.
- README's "what's here" section mentions the eval harness.

Open. Whether NOTES.md should also include a one-page "how to add a new bucket" tutorial. Defer; the eval phases 6-10 will add their own buckets and that walk-through is better demonstrated by example than documented prospectively.
