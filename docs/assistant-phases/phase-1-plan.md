---
title: plan · phase 1 · feat/transcripts
phase: 1
branch: feat/transcripts
references:
  - phase-1-brief.md
  - phase-1-architecture.md
---

# PLAN: phase 1 · feat/transcripts

Nine tasks. Execute in order. The depends-on field shows actual blocking constraints; tasks without a dependency in earlier rows could be done in parallel by separate sessions. Each task is one focused Claude Code session.

## Status

- [ ] T01: turn events and the event bus
- [ ] T02: vault primitives (paths, manifest, provenance)
- [ ] T03: vault writer with staging and atomic rename
- [ ] T04: session recorder
- [ ] T05: transcripts renderer
- [ ] T06: end-to-end wiring and startup sweep
- [ ] T07: integration tests (round-trip, cancellation, idempotency)
- [ ] T08: eval fixtures for phase 1
- [ ] T09: docs (ADR-006 through ADR-009, CHANGELOG, NOTES.md)

---

## T01: turn events and the event bus

Depends on: none

Scope. Add `app/chat/events.py` with typed events: `SessionStart`, `TurnStart`, `TurnStreamChunk`, `TurnEnd`, `TurnCancelled`, `SessionEnd`. A minimal in-process pub-sub bus (asyncio-based) where the chat loop publishes and subscribers consume. Modify `app/chat/loop.py` to publish events at the appropriate points without altering SSE chat behavior.

Acceptance.
- Subscriber receives `SessionStart`, then one or more `(TurnStart, N x TurnStreamChunk, TurnEnd)` cycles, then `SessionEnd` for a clean run.
- Disconnect mid-turn produces `TurnCancelled` followed by `SessionEnd`.
- Existing chat smoke test from init still passes.
- Logfire instrumentation continues to capture LLM calls; no new spans introduced by this task.

Open. Whether the bus supports multiple subscribers (phase 1 has one: the recorder) or is single-subscriber. Default to multi-subscriber; cost is negligible and phase 5 evals will want a second subscriber.

---

## T02: vault primitives (paths, manifest, provenance)

Depends on: none

Scope. Three small modules under `app/persistence/vault/`:

- `paths.py`: reads `VAULT_ROOT` from settings, exposes resolvers (`transcript_dir(date)`, `transcript_path(date, session_id)`, `manifest_path()`, `staging_dir()`). Asserts the vault root exists and is writable at first call.
- `manifest.py`: load and save `vault/.manifest/transcripts.json` as a mapping from session_id to `{path, sha256, written_at, status}`. Returns empty dict on missing file. On JSON parse error, log a warning and return empty (manifest is a cache, not a source of truth).
- `provenance.py`: marker constants (`^[inferred]`, `^[ambiguous]`) and a frontmatter ratio helper. Defined but unused at phase 1; tested but not wired in.

Acceptance.
- Unit tests for path resolution: fails fast if `VAULT_ROOT` is unset, returns expected paths otherwise.
- Manifest round-trip test: write, read, hash lookup.
- Manifest corruption test: bad JSON returns empty manifest, warning logged.
- Provenance helper renders frontmatter and markers correctly.

Open. None.

---

## T03: vault writer with staging and atomic rename

Depends on: T02

Scope. Implement `app/persistence/vault/writer.py`. An async writer that:

- acquires the module-level `asyncio.Lock`
- computes SHA-256 of incoming bytes
- consults the manifest; returns early if the hash matches
- writes to `.staging/{id}.tmp`, fsyncs, renames to the target path
- updates the manifest
- emits one Logfire span with path, size, latency, hit or miss

Public API: an async `write` function taking target path, byte content, and session metadata (session_id, status), returning a result that distinguishes wrote-vs-skipped and reports the resulting hash.

Acceptance.
- Unit tests: staging file present during write, absent after; rename is atomic on the test filesystem.
- Crash injection test: kill between fsync and rename; verify no half-written file at the target path.
- Manifest-hit test: identical bytes do not rewrite (returns skipped).
- Logfire span emitted with the documented fields.

Open. Whether to expose the lock as a public API (so background writers in phase 3+ can acquire it directly) or only as an internal detail of `writer.write()`. Defer; the first writer outside this phase forces the choice.

---

## T04: session recorder

Depends on: T01

Scope. `app/persistence/recorder.py`. Subscribes to the event bus. Maintains a per-session buffer keyed by session_id. Builds a `SessionRecord` (a pydantic model) as turns arrive, carrying: session_id, started_at, ended_at, model, status (completed or cancelled), and an ordered list of turn records. Each turn record carries role (user or assistant), content, started_at, ended_at, and a cancelled flag.

On `SessionEnd`, hand the completed record to the renderer (T05), which calls the writer (T03).

Acceptance.
- Unit tests with a fake event stream: the resulting record reflects the events accurately, including cancellation.
- Two concurrent sessions stay isolated in the buffer.

Open. None.

---

## T05: transcripts renderer

Depends on: T04 (for the `SessionRecord` shape)

Scope. `app/persistence/transcripts.py`. A pure function `render` that takes a session record and returns the target path and serialized bytes. Produces:

- YAML frontmatter per the architecture's transcript file format (ADR-008)
- `## turn N` headings with `**user**` and `**assistant**` sub-sections
- A `[cancelled]` marker line on the final turn if status is cancelled

Session id scheme per ADR-007 (generated upstream in T01 or T04, not here).

Acceptance.
- Snapshot tests against fixtures: completed two-turn session, cancelled mid-turn session, single-turn session.
- Re-parsing the rendered markdown into a `SessionRecord` reproduces the input (round-trip).

Open. None.

---

## T06: end-to-end wiring and startup sweep

Depends on: T01, T03, T04, T05

Scope. Wire recorder, renderer, and writer together in `app/main.py` startup. On app start:

- Validate `VAULT_ROOT`, create `transcripts/`, `.manifest/`, `.staging/` if missing.
- Sweep `.staging/` of any stale `.tmp` files left by prior crashes.
- Instantiate the event bus, recorder, and writer; subscribe the recorder to the bus.

On shutdown:

- Flush any in-flight session records to disk.

Acceptance.
- Manual smoke: run the app, complete one chat session, see the transcript at `vault/transcripts/{today}/{session_id}.md`.
- Restart with a leftover `.staging/xxx.tmp` file present; verify it is deleted on startup.
- No regressions in the init smoke test.

Open. Shutdown flush semantics: await all sessions, or best-effort with a timeout. Default to a 5-second timeout; sessions exceeding it are logged as lost.

---

## T07: integration tests (round-trip, cancellation, idempotency)

Depends on: T06

Scope. `tests/integration/test_transcripts.py`. Tests against a real FastAPI test client and a temp vault:

- Persistence round-trip: send a turn through the SSE endpoint, close, verify the file at the expected path re-parses to equivalent content.
- Cancellation: connect, send a user message, disconnect before the response completes. Verify the resulting transcript has the user message, partial assistant content, and a `[cancelled]` marker. `status: cancelled` in frontmatter.
- Idempotency: run two consecutive sessions producing identical content. Verify the manifest reports skipped on the second; mtime of the file unchanged.

Acceptance. All three tests pass on CI. No flakiness across 10 consecutive CI runs.

Open. None.

---

## T08: eval fixtures for phase 1

Depends on: T06

Scope. Add `vault/evals/phase-1/` with three fixture buckets:

- `persistence-roundtrip/`: sample session inputs and expected rendered transcripts. Verifiable, no LLM judge.
- `cancellation-marker/`: partial sessions and expected marker placement. Verifiable.
- `multi-turn-coherence/`: a handful of completed sessions for LLM-as-judge scoring of whether the rendered transcript reads as coherent. Rubric-based. Consumed by the eval harness once phase 5 lands; fixtures exist now.

Acceptance.
- Fixture files exist and load with the init's fixture format.
- The two verifiable buckets can be scored by a small standalone runner (placeholder until phase 5 builds the real harness).

Open. None.

---

## T09: docs (ADR-006 through ADR-009, CHANGELOG, NOTES.md)

Depends on: T03, T04, T05, T06 (decisions need to be implemented before they are documented)

Scope.

- ADR-006: manifest format (JSON, single file).
- ADR-007: session id scheme (timestamp + base32 nonce).
- ADR-008: transcript markdown layout (frontmatter + `## turn N` headings).
- ADR-009: vault-write coordination (`asyncio.Lock`).
- CHANGELOG entry under `## [unreleased]`; promote to a version on merge.
- NOTES.md section titled "Phase 1: persistence and vault-write primitives." Explains the one concept this phase teaches: the staging plus atomic-rename plus manifest pattern as the contract every later phase inherits. Reference the relevant code paths.

Acceptance.
- All four ADRs present in `docs/adr/`.
- CHANGELOG and NOTES.md updated.
- README's "what's here" section mentions transcripts if init's README needs that update.

Open. Whether NOTES.md is one growing file or one file per phase. Default to one file with a section per phase; revisit at phase 5 if it gets unwieldy.
