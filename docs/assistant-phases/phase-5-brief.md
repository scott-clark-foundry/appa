---
title: brief · phase 5 · feat/eval-harness
phase: 5
branch: feat/eval-harness
tier: service
---

# Brief: phase 5 · feat/eval-harness

**Tier:** service

**Goal.** Stand up a unified eval harness that loads per-phase fixtures, runs each capability against them in-process, scores results via verifiable mechanical checks and LLM-as-judge rubrics, caches judge calls to control cost, stores results for rollups, and supports A/B comparison and judge-human agreement validation. Bring phases 1-4 under harness coverage and validate every rubric against operator-labeled spot-checks.

**Starting state.** Init plus phases 1-4 have shipped:

- Phases 1-4 each shipped their fixture set under `vault/evals/{phase}/`, with placeholder or standalone runners that approximate harness behavior
- All eval-relevant capabilities are importable as functions: `recall.retrieve`, `memory.inject.render`, `memory.ingest`, `memory.age.check_and_evict`, `skills.match.match`, `skills.pack.pack`, plus phase-1's transcripts roundtrip
- Three SQLite stores in `INDEX_ROOT/`: `index.db`, `memory.db`, `skills.db`
- ADRs 001-028 baked in. ADR-001 binds chat to pydantic-ai's Agent and structured outputs to `direct.model_request`; I9 requires no direct provider SDK imports.
- Logfire tracing for every model call (I5)

**Inputs.**

- Fixture files at `vault/evals/{phase}/{bucket}/*.md` with frontmatter and body. The format was sketched in phase 1 and used iteratively in phases 2-4; phase 5 commits to it formally.
- The capability modules listed in starting state
- Rubrics, either inline in fixtures (for ad-hoc rubric tweaks) or in `vault/evals/_rubrics/{name}.md` (for rubrics referenced from many fixtures)
- Operator-labeled ground-truth scores on a held-out spot-check slice (30-50 examples per rubric bucket per the phase-1 design note)
- Configuration overrides supplied at run time (different model strings, thresholds, budgets, prompt versions)

**Outputs.**

- A results store at `{INDEX_ROOT}/evals.db` (SQLite) carrying runs, run configs, fixture results, judge agreement reports
- A `vault/evals/_runs/{run_label}/` directory of human-readable result snapshots (markdown summaries; one per run) for git-trackable history
- A diskcache directory at `{INDEX_ROOT}/evals_cache/` keyed on (judge model, rubric hash, input hash)
- CLI surface: `assistant eval run`, `assistant eval compare`, `assistant eval validate`, `assistant eval label`, `assistant eval status`
- Rollups in the CLI output: per fixture, per bucket, per phase, with deltas when comparing runs
- A judge-validation report per rubric bucket: judge-vs-human agreement rate, Cohen's kappa for ordinal rubrics, sample of disagreements
- An architecture.md section: "evals: fixtures, runners, scorers, judges, validation"

**Done criteria.**

- All phase 1-4 fixture buckets execute through `assistant eval run --phase {n}` without error.
- Verifiable buckets produce identical results to the standalone runners shipped with phases 1-4 (which serve as the regression check).
- Judge calls hit the diskcache on identical re-runs; a fresh judge invocation costs at least one API call and a re-run costs zero.
- `assistant eval compare run-a run-b` renders a side-by-side delta in `rich`.
- `assistant eval label` walks a rubric bucket and lets the operator assign ground-truth scores, persisting them to the fixture frontmatter.
- `assistant eval validate` computes judge-human agreement against operator-labeled slices and reports per-bucket numbers.
- Operator has labeled 30-50 examples per rubric bucket (the phase-1 statistical-noise note), and every rubric used in phases 1-4 has a validation report committed under `vault/evals/_runs/`.
- Full CI green; no regression in phases 1-4 capabilities.
- CHANGELOG entry under `## [unreleased]`; NOTES.md section explaining the one concept this phase teaches.
- ADRs filed for: fixture format, results store, scorer architecture, judge cache key, comparison semantics, rubric storage, agreement metric.

**Non-goals.**

- Trajectory evals. Phase 6 introduces the first tool; phase 6's own PLAN extends the harness with trajectory scoring then.
- Continuous monitoring. No production traffic exists.
- Statistical significance testing. Sample sizes are too small; the harness reports effect sizes and lets the operator judge.
- A web UI. The CLI is the operator surface.
- Distributed eval runs.
- Auto-bisecting against git history. Worthwhile later; not before the harness has matured.
- Versioned fixture sets. Git carries fixture history; the harness reads what's on disk.
- Eval-time training, adapters, or model fine-tuning.
- Fixtures for phases 6-10. Each phase ships its own fixtures and extends the harness only as needed.

**Persistence.**

- Fixtures stay in `vault/evals/{phase}/{bucket}/*.md`. The fixture format follows Skills-spec frontmatter conventions per I6 but is not itself Skills-spec compliant (fixtures are not agent-readable instructions). Top-level keys (`name`, `description`) reserved; phase-5 fields under `metadata.*`. Required `metadata.*`: `phase`, `bucket`, `type` (`verifiable_single`, `verifiable_stateful`, `rubric_single`, `rubric_multi_turn`), `expected` (a typed dict per type). Optional `metadata.*`: `human_score` (set by `label`), `human_reasoning`, `human_labeled_at`, `human_labeled_by`. Body holds either the rubric (when fixture has an inline rubric) or procedural setup notes.
- Rubrics referenced from many fixtures live at `vault/evals/_rubrics/{name}.md` and are referenced by `metadata.rubric_ref`. Inline rubrics in the fixture body override the ref.
- Results store at `{INDEX_ROOT}/evals.db`. Schema: `runs` (run_id, label, started_at, ended_at, config_snapshot, total_fixtures, passed, failed, errored), `fixture_results` (run_id, fixture_path, bucket, type, score, human_score, judge_score, judge_reasoning, judge_cost, latency, cached, error). `runs.config_snapshot` is a JSON column with the full override set.
- Human-readable run snapshots at `vault/evals/_runs/{run_label}/summary.md`. One row per fixture; rollups at top; written through the phase-1 vault writer.
- Judge cache at `{INDEX_ROOT}/evals_cache/`. Keyed on `sha256(judge_model || rubric_content || fixture_input)`. Editing the rubric or changing the judge model invalidates cache entries automatically.

**Where it runs.** Operator's laptop, single process. The harness runs as a CLI; it does not require the FastAPI app to be running.

**Constraints.**

- Judges use `direct.model_request` per ADR-001 and I9. The harness imports the capability modules directly; it never goes through pydantic-ai's Agent (which is what's being evaluated, not what's evaluating).
- Capability invocations import the relevant modules and call them as functions. No FastAPI test client in the eval hot path; the per-phase runner manages state setup and teardown directly. The harness can take longer paths (e.g., a real chat turn through the Agent) when a rubric demands the full stack, but only when necessary.
- All judge calls are Logfire-traced (judge model, input hash, cache hit/miss, latency, cost). Capability invocations are Logfire-traced via the capabilities' own existing spans.
- The judge cache key includes the rubric content hash, so any rubric edit invalidates cached scores for that rubric. The cache is keyed loosely enough that a fixture's `expected` change does not invalidate (the judge does not see `expected`).
- The harness commits to one judge model per rubric per run. Mixed-judge runs are not supported in phase 5; revisit if rubric-specialist judges materialize.
- Test state isolation: every fixture runs against fresh temp directories for `INDEX_ROOT`, `VAULT_ROOT`, and the embeddings cache. State leaks between fixtures are bugs.
- Diskcache library handles concurrent reads safely; the harness serializes writes through a single in-process lock so that re-runs are deterministic.
- Configuration overrides are passed programmatically to runners via a typed `RunConfig`. Env-var overrides are also supported for the CLI surface (`--override KEY=value`). Configs are captured verbatim into `runs.config_snapshot`.

**Failure tolerance.**

- Fixture parse error: log structured warning, skip, continue. The run completes with `errored` count >= 1.
- Capability invocation raises: capture the exception, record as an error row in `fixture_results`, continue.
- Judge call fails after retry: record `judge_score: NULL` and `error: <message>`, continue. The bucket rollup excludes errored rows.
- Diskcache miss during a "must hit" expectation (e.g., a re-run): no special handling; the harness records the cache miss in Logfire and re-runs the judge. Cache misses on a re-run indicate a rubric or model change, which is intentional.
- Operator interrupts mid-run (Ctrl-C): the harness commits completed fixtures, marks the run `interrupted`, and exits cleanly.
- Concurrent runs against the same results store: SQLite WAL handles read concurrency; writes serialize through the in-process lock. Two processes running `eval run` simultaneously is unsupported; the second fails fast.
- Operator-labeled fixtures conflict with a re-label (e.g., label workflow run twice on the same fixture): the existing `human_score` is shown; the operator confirms overwrite. No silent stomp.
- Logfire unreachable: harness continues; spans go to stdout via structlog fallback. The eval result is unaffected.

**Open questions (left to the architecture).**

- Results-store schema details: one table per concept (runs, fixture_results) or a denormalized single table. The brief leans normalized; architecture commits.
- Whether to commit `evals.db` to git. The brief leans no (results are reproducible from fixtures plus capability code); the human-readable `_runs/{label}/summary.md` is committed in its place. Architecture commits.
- How operator labels are stored: in the fixture file's frontmatter (the brief's leaning), or in a parallel `vault/evals/_labels/{phase}.json` file (less merge-friendly but separates labels from fixture content). Architecture commits.
- Comparison semantics for two runs over the same fixtures: per-fixture delta, bucket rollup delta, or both. The brief expects both.
- Default judge model. The architecture commits a specific model string and documents the cost-per-1000-fixtures estimate in the ADR.
- Whether `assistant eval validate` reports Cohen's kappa, Spearman ρ, or simple agreement rate for ordinal rubrics. Architecture commits a default per rubric type.
- Whether the harness supports running a subset of a bucket via glob or tag filters (`--filter "memory*"`). The brief leans yes; architecture defines the syntax.
- Whether failed runs are retained or auto-cleaned. The brief leans retained (failure modes are themselves diagnostic), with an `eval prune --keep-last N` to manage growth.
- Rubric versioning. Edits to a rubric file invalidate cache; should the harness also track which rubric version produced which score? Architecture decides; the cleanest answer is yes, by recording the rubric hash on each `fixture_results` row.
