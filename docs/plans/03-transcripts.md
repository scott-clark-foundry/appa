---
title: "Phase 1 transcripts: JSONL persistence + vault-write primitives + server-canonical state"
summary: "Land the first persistence layer. Every pydantic-ai Agent.run() from /chat (AG-UI) and /chat/sync (plain JSON) appends to a per-conversation JSONL under vault/transcripts/{project}/{date}/. Stand up the cross-phase vault-write primitives (writer + manifest + asyncio.Lock + atomic-rename). Make the server canonical for conversation state: the handler reconstructs message_history from JSONL and passes it to Agent.run(conversation_id=thread_id, message_history=...)."
status: draft
author: planner
phase: 1
spec: ../specs/03-transcripts.md
progression: "../plans/python-llm-app-progression.md#l1"
branch: feat/transcripts
started: 2026-05-23
tags: [persistence, jsonl, vault-write-primitives, pydantic-ai, ag-ui, server-canonical]
references:
  - ../references/vault-write-primitives.md
  - ../references/jsonl-transcript-format.md
  - "(assistant/) docs/references/ag-ui-surface.md"
---

# Phase 1 transcripts: JSONL persistence + vault-write primitives + server-canonical state

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Every pydantic-ai `Agent.run()` produces a replay-grade JSONL record under `vault/transcripts/{project}/{YYYY-MM-DD}/{started_at}-{thread8}.jsonl`. Both `/chat` (AG-UI streaming) and `/chat/sync` (plain JSON) capture. The server is canonical for conversation history.

**Architecture.** Two new sub-packages in `assistant/`. `persistence/vault/` provides protocol-agnostic primitives (`writer.append`, `writer.write_replace`, `manifest`, `paths`, module-level `asyncio.Lock`). `persistence/transcripts/` provides the JSONL-specific surface (envelope models, encoder, decoder, reader, recorder). The chat handlers read history via the reader, run the agent with `conversation_id=thread_id` and `message_history=...`, and append events via the recorder. The AG-UI handler drops to the manual `AGUIAdapter` flow (pre-authorized by `assistant/docs/plans/01-ag-ui-migration.md` ADR D4) so the recorder can observe each run's messages.

**Tech stack.** No new top-level runtime deps. `python-ulid` for sortable event identifiers (small, single-purpose, MIT). pydantic-ai 1.102+ (already pinned). `asyncio.Lock` (stdlib). Settings already exposes `VAULT_PATH`; this phase adds `DEFAULT_PROJECT`. Cross-phase contracts: see References above.

**References:**
- `docs/references/vault-write-primitives.md` (this phase introduces it; the planner-seed contract; Task 1 refines)
- `docs/references/jsonl-transcript-format.md` (this phase introduces it; Task 1 verifies and refines)
- `assistant/docs/references/ag-ui-surface.md` (the AG-UI wire-shape ref shipped in phase 0 amendment; this phase reads it, does not amend it)

---

## 01. Intent

> [!TIP] Goal
> One JSONL file per conversation (`thread_id`). One line per pydantic-ai `ModelMessage`. Lifecycle markers (`conversation_start`, `run_start`, `run_end`) bracket each run. Both `/chat` and `/chat/sync` capture without changing their public wire format. The server reads back its own JSONL to seed `message_history` on the next POST. The vault-write primitives that ship here are the same ones phases 3, 4, 8, and 10 will reuse.

> [!NOTE] Non-goals (carried verbatim from spec §"What's outside phase 1")
> - Markdown view of a JSONL. Future utility; deferred.
> - `.aux/<sha256>` spill-to-file logic. Shape defined (`binary_ref`, `instructions_ref`) so later phases inherit; no writes to `.aux/` in phase 1.
> - Edit-feedback from Obsidian.
> - Multi-process write coordination.
> - Pruning, archival, compaction.
> - CLI subcommands (`assistant transcripts list / replay / export`).
> - Provenance markers (`^[inferred]`, `^[ambiguous]`). Deferred to phase 3.

> [!IMPORTANT] Key insight
> The two wires (AG-UI streaming vs sync JSON) need different capture mechanics but share the same recorder. Sync is trivial: `result = await agent.run(...)` then `result.new_messages()` is right there. AG-UI is the hard one: `AGUIAdapter.dispatch_request` returns a `StreamingResponse` with no exposed result object, so phase 1 drops to the manual `build_run_input` / `AGUIAdapter(...).run_stream()` / `.encode_stream()` flow. Whether that manual flow exposes a `result.all_messages()` after the stream completes is what Task 1 probes; the answer decides Task 10's contract.

## 02. Tech stack

- **pydantic-ai 1.102+** (already pinned). Uses `Agent.run(conversation_id=, message_history=)`, `result.all_messages()`, `result.new_messages()`. Manual AG-UI flow: `AGUIAdapter.build_run_input`, `AGUIAdapter(...).run_stream()`, `.encode_stream()`.
- **fastapi / uvicorn / httpx** unchanged.
- **asyncio.Lock** (stdlib). One module-level Lock serializes all vault writes. Task 1 reconfirms this is the right primitive vs `anyio.Lock`.
- **python-ulid** (new dep). Sortable event identifiers for the envelope `uuid` field. Lightweight; one function (`ulid.new()`). Preflight adds it via `uv add python-ulid`.
- **pydantic** (already present): envelope models are pydantic BaseModels with a discriminated `kind` field; payload is `pydantic_ai.messages.ModelMessage` (the union).

Cross-phase context (file layout, event kinds, part taxonomy, reference shapes, reader policy, encode/decode round-trip guarantee): `docs/references/jsonl-transcript-format.md`. API surface and invariants for `writer` / `manifest` / `paths` / `Lock`: `docs/references/vault-write-primitives.md`.

## 03. Design

```mermaid
sequenceDiagram
  participant C as Client (browser/CLI/Python)
  participant H as FastAPI handler (/chat or /chat/sync)
  participant R as transcripts.reader
  participant A as pydantic-ai Agent
  participant Rec as transcripts.recorder
  participant W as vault.writer (lock + append)
  participant M as vault.manifest

  C->>H: POST {thread_id, message, project?}
  H->>R: read_conversation(project, thread_id)
  R-->>H: list[ModelMessage] (server-canonical history)
  H->>Rec: ensure_conversation_started(project, thread_id, client_meta)
  Rec->>W: append(path, conversation_start line)  [first POST only]
  Rec->>M: set(("transcripts", (project, thread_id)), entry)
  H->>Rec: run_start(run_id, agent_name, model, instructions)
  Rec->>W: append(path, run_start line)
  H->>A: Agent.run(latest_user_msg, conversation_id=thread_id, message_history=...)
  Note over A: streams text deltas back to client via AG-UI (if /chat)
  A-->>H: result (sync) OR adapter exposes messages (AG-UI; Task 1 decides)
  H->>Rec: append_messages(result.new_messages())
  loop per new ModelMessage
    Rec->>W: append(path, model_message line) + fsync
  end
  H->>Rec: run_end(status, duration_ms)
  Rec->>W: append(path, run_end line)
  H-->>C: streamed AG-UI events (or JSON {output}) -- unchanged
```

### Module map

New under `assistant/`:

```
assistant/
  persistence/
    __init__.py
    vault/
      __init__.py
      paths.py         # resolve_vault_root, staging_dir, manifest_path, aux_path
      writer.py        # async append, async write_replace, module-level Lock
      manifest.py      # get / set / flush / rebuild_from_vault; on-disk JSON per kind
    transcripts/
      __init__.py
      events.py        # pydantic envelope models (Conversation/Run/MM/RunEnd events)
      encoder.py       # ModelMessage + lifecycle args -> serialized envelope lines
      decoder.py       # parse a JSONL line -> envelope; reconstruct ModelMessage list
      reader.py        # read_conversation(project, thread_id) -> list[ModelMessage]
      recorder.py      # high-level: ensure_conversation_started, run_start, append_messages, run_end
```

Modified in `assistant/`:

```
assistant/
  app.py               # both endpoints read history, drive recorder, drop to manual AG-UI flow
  config.py            # Settings.DEFAULT_PROJECT (default "default"); project regex validator
  client.py            # AssistantClient.stream_chat(message, *, thread_id=None, project=None)
```

Tests added under `tests/`:

```
tests/
  test_vault_paths.py
  test_vault_writer.py
  test_vault_manifest.py
  test_transcripts_envelope.py
  test_transcripts_encoder.py
  test_transcripts_decoder.py
  test_transcripts_reader.py
  test_transcripts_recorder.py
  test_transcripts_roundtrip.py        # round-trip every part_kind in isolation
  test_app_chat_sync_capture.py
  test_app_chat_ag_ui_capture.py
  test_app_server_canonical_history.py
  test_app_cancellation.py
```

### Test seams

- **VAULT_PATH**: every test builds `Settings(_env_file=None, VAULT_PATH=tmp_path / "vault")` via `make_test_settings` and passes through `build_app(settings)`. The writer reads vault root once at startup via `paths.resolve_vault_root()`; no global state to reset between tests because each test gets a fresh app instance.
- **Clock**: `recorder.run_start(..., now=...)` accepts an optional `datetime` for deterministic timestamps; production callers pass `datetime.now(timezone.utc)`. The encoder receives ISO strings, not `datetime`s.
- **UUID/ULID factory**: `recorder` accepts an optional `id_factory: Callable[[], str]` defaulting to `ulid.new().str`. Tests inject a counter-backed factory.
- **Agent override**: phase 0's `app.dependency_overrides[get_agent] = lambda: Agent(model=TestModel(), output_type=str)` continues to work; the recorder is wired through the handler, not through the Agent.
- **httpx.ASGITransport**: full request-cycle tests run the FastAPI app in-memory; no real network or external model calls.

## 04. Decisions

Inherited from spec, not re-decided here:

- **D1** JSONL not markdown. Encoder writes JSONL. (Tasks 5-6 implement.)
- **D2** Server-canonical history. Handler reads via `reader`, passes to `Agent.run(message_history=...)`. Latest client `messages[-1]` becomes the request body's user message; everything earlier is ignored. (Tasks 9-10 implement; Task 9 verifies.)
- **D3** Layout: `vault/transcripts/{project}/{date}/{started_at}-{thread8}.jsonl`. (Task 2 implements `paths.py`.)
- **D4** Project from client (Python `project=` kwarg; sync wire `project` JSON field); server-side default from `Settings.DEFAULT_PROJECT`; regex-validated. **Decided here:** `DEFAULT_PROJECT` ships in phase 1 alongside the regex validator; we don't split it into a separate iteration. Same task, same diff. (Task 2 implements; Task 11 wires the client.)
- **D5** Per-message append granularity. Writer appends + fsyncs per line. (Task 3 implements.)
- **D6** Cancellation = `run_end` with `status: "cancelled"`. AG-UI handler catches `asyncio.CancelledError`, queries `result.new_messages()` for whatever landed, appends those, then `run_end`. (Task 10 implements; Task 10 tests.)
- **D7** Capture path differs by wire. `/chat/sync` uses `result.new_messages()` directly. `/chat` uses the manual AGUIAdapter flow per Task 1's findings. (Tasks 9-10.)
- **D8** Vault-write primitives scope: writer + manifest + lock + paths. No provenance markers, no `.patch.md`, no `.aux/` writes in phase 1. (Tasks 2-4.)
- **D9** `.aux/<sha256>` shape defined; phase 1 does not write to `.aux/`. The reference doc has the shape; the encoder treats `BinaryContent` inline (no spill). (Encoder contract in Task 6; round-trip test in Task 7.)
- **D10** Subagent (sidechain) events in the same file as the parent. Phase 1 has no tools and therefore no sidechains; the encoder's envelope schema supports `is_sidechain: true` and the linkage fields but no production code path emits them. The decoder accepts them; the reader filters `is_sidechain == True` out of the returned `message_history`. (Tasks 5-7.)

Decided in this plan (open questions from spec §"Open questions"):

- **Plan-side**: `Settings.DEFAULT_PROJECT` ships in phase 1 (alongside the project regex validator). Not a separate scaffold-level iteration.
- **Plan-side**: `02-post-scaffold-iteration.md` mirroring to `scratch/` is out of scope here. Surface it in §10 Open questions for the next planning round.
- **Plan-side**: `CLAUDE.md` `NN` convention update (NN is no longer the phase number; it's the plan-sequence index) is out of scope. Surface in §10.

## 05. Changeset

Created:

- `assistant/persistence/__init__.py`
- `assistant/persistence/vault/__init__.py`
- `assistant/persistence/vault/paths.py`
- `assistant/persistence/vault/writer.py`
- `assistant/persistence/vault/manifest.py`
- `assistant/persistence/transcripts/__init__.py`
- `assistant/persistence/transcripts/events.py`
- `assistant/persistence/transcripts/encoder.py`
- `assistant/persistence/transcripts/decoder.py`
- `assistant/persistence/transcripts/reader.py`
- `assistant/persistence/transcripts/recorder.py`
- `tests/test_vault_paths.py`
- `tests/test_vault_writer.py`
- `tests/test_vault_manifest.py`
- `tests/test_transcripts_envelope.py`
- `tests/test_transcripts_encoder.py`
- `tests/test_transcripts_decoder.py`
- `tests/test_transcripts_reader.py`
- `tests/test_transcripts_recorder.py`
- `tests/test_transcripts_roundtrip.py`
- `tests/test_app_chat_sync_capture.py`
- `tests/test_app_chat_ag_ui_capture.py`
- `tests/test_app_server_canonical_history.py`
- `tests/test_app_cancellation.py`

Modified:

- `assistant/config.py` (add `DEFAULT_PROJECT` field + project-name regex constant; no other behavior change)
- `assistant/app.py` (both endpoints add server-canonical history + recorder; `/chat` drops to manual AGUIAdapter flow)
- `assistant/client.py` (`AssistantClient.stream_chat` accepts optional `thread_id` and `project`; default behavior unchanged)
- `pyproject.toml` (add `python-ulid` dependency)
- `docs/references/vault-write-primitives.md` (set `last-verified`, pin pydantic-ai version, confirm `asyncio.Lock` choice and span attribute names)
- `docs/references/jsonl-transcript-format.md` (set `last-verified`, paste `## Sample lines` for each `part_kind` probed, confirm discriminator strings)
- `docs/plans/python-llm-app-progression.md` (update phase 1's `Artifacts.` line to include "merged" status after the squash; deferred to Task 13)
- `assistant/CHANGELOG.md` (entry for `0.1.0`)
- `assistant/README.md` (transcript-capture note in the chat section)
- `assistant/NOTES.md` (new `## Transcript persistence + vault-write primitives` section)

## 06. Tasks

Thirteen tasks plus preflight. Each task ends with a commit. Run on branch `feat/transcripts` off `main`. Squash-merge to `main` when remote CI is green and every box in §08 Acceptance is ticked.

### Preflight (do before branching)

Single goal: don't start a branch you'll have to abandon.

- [ ] **PF1.** `assistant/docs/plans/02-post-scaffold-iteration.md` is merged to `main` on the remote (post-scaffold iteration shipped). `cd ../assistant && git log main --oneline -1` shows the iteration squash. _(scott)_
- [ ] **PF2.** `python-ulid` import probe: `uv run python -c "import ulid; print(ulid.new())"` succeeds (or returns ModuleNotFoundError, in which case add it). If absent, `uv add python-ulid`, then re-probe. Commit on `main` (or fold into Task 2's first commit) as `chore(deps): add python-ulid for transcript event ids`. _(scott)_
- [ ] **PF3.** Confirm pydantic-ai pin: `uv run python -c "import pydantic_ai; print(pydantic_ai.__version__)"` reports a version that satisfies `>=1.102,<2`. If not, raise the floor in `pyproject.toml` and `uv sync`. _(scott)_
- [ ] **PF4.** Create the branch: `cd ../assistant && git checkout main && git pull && git checkout -b feat/transcripts`. _(scott)_

### Task 1: Probe pydantic-ai surfaces; refine reference docs

**Files:** `docs/references/vault-write-primitives.md`, `docs/references/jsonl-transcript-format.md`. No production code.

**Contract.** By end of task, both reference docs have `last-verified` set to today's date; `jsonl-transcript-format.md` has a `## Sample lines` section with one redacted sample per probed `part_kind`; the `part_kind` discriminator strings in `## Part taxonomy` match `ModelRequestPart` / `ModelResponsePart` discriminator values exactly; the `RequestUsage` field names match `RequestUsage.model_fields.keys()`; one of the two AG-UI capture paths is selected and documented in `jsonl-transcript-format.md` under a new `## AG-UI capture path` heading (either "adapter exposes result.all_messages() after run_stream completes" or "event-stream tap + reconstruct from text-content events").

**The investigation has four probes.** Each probe is a one-off Python script run with `uv run python -c "..."` (the implementer may write a temporary file if the script grows past a few lines; the file is not committed). The findings get written into the reference docs; the probe scripts themselves do not.

- [ ] **1.1** Probe `AGUIAdapter` result access. Build an inline FastAPI app, wire `/probe` to the manual flow (`build_run_input` → `AGUIAdapter(agent, run_input, accept)` → `.run_stream()` → `.encode_stream()`), drive it with a TestModel-backed Agent, POST a minimal `RunAgentInput`, drain the SSE stream, then inspect `adapter.result` (the instance after `.run_stream()` completes). Record: does the adapter instance expose `.result.all_messages()`? Does it expose anything equivalent (`.messages`, `.last_run`, etc.)? Capture the output in chat for the user to confirm before deciding the path. _(scott)_
- [ ] **1.2** Probe `ModelMessage` round-trip. In a Python REPL or script: build a small `ModelRequest` (with a `UserPromptPart`) and a small `ModelResponse` (with a `TextPart`); serialize via `msg.model_dump(mode="json")`; deserialize via `ModelRequest.model_validate(...)` / `ModelResponse.model_validate(...)`, discriminating on the `"kind"` field. Confirm `decoded == original` (pydantic equality). If `ModelMessagesTypeAdapter` is exported from `pydantic_ai.messages`, use that instead and record the import path. _(scott)_
- [ ] **1.3** Probe `part_kind` discriminator strings. `from pydantic_ai.messages import ModelRequestPart, ModelResponsePart` then print the literal discriminator values for every part class (the implementer locates them via `__pydantic_fields__["part_kind"]` or `__discriminator_values__` (pydantic-ai's exact attribute name varies; find the live one)). Expect strings like `"user-prompt"` vs `"user_prompt"`; the seed reference doc guessed `user_prompt` snake-case but the wire may differ. _(scott)_
- [ ] **1.4** Probe `RequestUsage` shape. `from pydantic_ai.usage import RequestUsage; print(RequestUsage.model_fields.keys())`. Confirm `input_tokens` / `output_tokens` / `total_tokens` or capture the actual names. _(scott)_
- [ ] **1.5** Update `docs/references/jsonl-transcript-format.md`:
  - Replace the `part_kind` table strings with verified discriminator values from 1.3.
  - Replace `RequestUsage` field names with verified shape from 1.4.
  - Add a new top-level section `## AG-UI capture path` (placed between `## Reader policy` and `## Encode / decode round-trip`) recording the choice from 1.1. Two-paragraph max: the chosen path, and the rejected one with one sentence of why.
  - Add `## Sample lines` at the end with one redacted JSONL line per `part_kind` (request: `user_prompt`, `system_prompt`, `tool_return`, `retry_prompt`, `builtin_tool_return`; response: `text`, `tool_call`, `thinking`, `builtin_tool_call`). For part kinds the probe didn't exercise live (`builtin_tool_*`), paste a hand-written example from the spec doc with a `# example, not probed` comment.
  - Set `last-verified` to today's date; set `pydantic-ai-pin` to the verified installed minor-version range.
  _(scott)_
- [ ] **1.6** Update `docs/references/vault-write-primitives.md`:
  - Confirm `asyncio.Lock` is the right choice (vs `anyio.Lock`). FastAPI is asyncio-native; the writer module will be too. If `pydantic_ai` documents an `anyio` requirement that affects shared state, escalate before deciding. Note the choice and rationale in the doc.
  - Confirm Logfire span attribute names against `assistant/logging_setup.py` namespacing. If `vault.*` doesn't conflict, keep it; if there's already a `gen_ai.*`-style convention to mirror, adjust to match.
  - Set `last-verified` to today's date.
  _(scott)_
- [ ] **1.7** Run `uv run ruff check && uv run ruff format --check && uv run mypy assistant` to confirm no production code changed (these should be clean). Run `uv run pytest` to confirm no test regressions (none expected; this task is docs-only). _(scott)_
- [ ] **1.8** Commit: `docs(refs): verify pydantic-ai 1.102 surface; pick AG-UI capture path`. _(scott)_

### Task 2: Vault paths + Settings.DEFAULT_PROJECT + project regex

**Files:**
- Create: `assistant/persistence/__init__.py` (empty), `assistant/persistence/vault/__init__.py` (empty), `assistant/persistence/vault/paths.py`
- Modify: `assistant/config.py`
- Test: `tests/test_vault_paths.py`

**Contract.**

`assistant/persistence/vault/paths.py` exposes:

```python
PROJECT_NAME_REGEX: re.Pattern[str]  # compile of ^[a-zA-Z0-9_-]{1,64}$

def validate_project_name(name: str) -> str:
    """Return name if it matches PROJECT_NAME_REGEX; raise ValueError otherwise."""

def resolve_vault_root(settings: Settings) -> Path:
    """Read settings.VAULT_PATH. Validate the directory exists and is writable.
    Create the directory tree (vault root + .manifest/ + .staging/ + transcripts/.aux/)
    on first call if missing. Fail-fast with RuntimeError on permission errors.
    """

def transcripts_dir(vault_root: Path) -> Path: ...
def transcripts_aux_dir(vault_root: Path) -> Path: ...
def staging_dir(vault_root: Path) -> Path: ...
def manifest_path(vault_root: Path, kind: str) -> Path: ...
def conversation_path(vault_root: Path, project: str, started_at: datetime, thread_id: str) -> Path:
    """vault/transcripts/{project}/{YYYY-MM-DD}/{YYYYMMDDTHHMMSS}-{thread8}.jsonl
    Filename derived from started_at (UTC, compact ISO without separators) and the
    first 8 hex characters of thread_id (after stripping dashes). Caller is
    responsible for `mkdir(parents=True, exist_ok=True)` on the date dir."""
```

`Settings` (in `assistant/config.py`) gains one new field:

```python
DEFAULT_PROJECT: str = "default"
```

No regex validation in the field declaration (Settings is the env-reading layer; validation lives at the path-construction call site where it's actionable). The Settings docstring mentions the default and points at `validate_project_name` for the regex.

**Tested by:**
- `test_validate_project_name_accepts_examples`: `"default"`, `"agent-builder"`, `"abc_123"`, 64-char string all pass.
- `test_validate_project_name_rejects_examples`: `""`, `"a/b"`, `".hidden"`, `"a b"`, 65-char string, `"a.b"` all raise `ValueError`.
- `test_resolve_vault_root_creates_tree`: given `tmp_path / "vault"` (does not yet exist), `resolve_vault_root` creates `vault/`, `vault/.manifest/`, `vault/.staging/`, `vault/transcripts/.aux/`.
- `test_resolve_vault_root_fail_fast_on_unwritable`: pre-create the directory mode 0o500; `resolve_vault_root` raises `RuntimeError` mentioning the path.
- `test_conversation_path_shape`: pass a fixed `datetime(2026, 5, 23, 14, 30, 12, tzinfo=timezone.utc)` and `thread_id="a3f8d1e0-1234-5678-9abc-def012345678"`; assert returned path is `<vault>/transcripts/default/2026-05-23/20260523T143012-a3f8d1e0.jsonl`.
- `test_settings_default_project_is_default`: `make_test_settings().DEFAULT_PROJECT == "default"`.
- `test_settings_default_project_override`: `make_test_settings(DEFAULT_PROJECT="agent-builder").DEFAULT_PROJECT == "agent-builder"`.

- [ ] **2.1** Write `tests/test_vault_paths.py` with the seven test cases above. _(scott)_
- [ ] **2.2** Run `uv run pytest tests/test_vault_paths.py -v`. Expect failure (`ImportError` for `assistant.persistence`). _(scott)_
- [ ] **2.3** Create `assistant/persistence/__init__.py` and `assistant/persistence/vault/__init__.py` (both empty). _(scott)_
- [ ] **2.4** Implement `assistant/persistence/vault/paths.py` to satisfy the contract. _(scott)_
- [ ] **2.5** Add `DEFAULT_PROJECT: str = "default"` to `Settings` in `assistant/config.py`. _(scott)_
- [ ] **2.6** Run `uv run pytest tests/test_vault_paths.py -v`. All seven tests pass. _(scott)_
- [ ] **2.7** Run `uv run pytest` (full suite). All previously-passing tests still pass. _(scott)_
- [ ] **2.8** Run `uv run ruff check && uv run ruff format --check && uv run mypy assistant`. Clean. _(scott)_
- [ ] **2.9** Commit: `feat(persistence): vault paths + Settings.DEFAULT_PROJECT + project regex`. _(scott)_

### Task 3: Vault writer (append + write_replace + lock)

**Files:**
- Create: `assistant/persistence/vault/writer.py`
- Test: `tests/test_vault_writer.py`

**Contract.**

```python
@dataclass(frozen=True)
class WriteResult:
    path: Path
    bytes_written: int
    op_kind: Literal["append", "write_replace"]
    latency_ms: float

# Module-level lock: every public function acquires it.
_LOCK: asyncio.Lock

async def append(path: Path, line: str) -> WriteResult:
    """Append `line + "\\n"` to path. Acquires _LOCK; opens in append mode;
    writes; flushes; fsyncs the fd; closes. Returns the WriteResult.
    Creates parent directories with mkdir(parents=True, exist_ok=True) before
    open. Emits exactly one Logfire span per call with attributes
    `vault.path` (vault-relative if under vault_root, else absolute),
    `vault.bytes_written`, `vault.latency_ms`, `vault.op_kind="append"`.
    Raises OSError on disk failures; caller logs and decides whether to retry."""

async def write_replace(path: Path, data: bytes, *, vault_root: Path) -> WriteResult:
    """Atomically replace path content. Acquires _LOCK; writes to
    `vault_root/.staging/<random>.tmp`; fsyncs; renames to path; emits
    one Logfire span (op_kind="write_replace"). Returns WriteResult.
    Not used by phase 1; tested for the atomic-rename behavior."""
```

The writer does not know about manifest. Manifest updates happen at the recorder layer (transcript writes) or at the next consumer's call site (phase 3+ memory).

**Tested by:**
- `test_append_creates_file_with_trailing_newline`: `append(path, "hello")` then read path; content equals `"hello\n"`.
- `test_append_serializes_concurrent_writers`: launch 50 concurrent `asyncio.gather(append(path, f"line {i}"))`; afterward the file has 50 lines, each correctly terminated, no torn writes. (Verifies the lock works.)
- `test_append_creates_parent_dirs`: `append(tmp_path / "a" / "b" / "c.jsonl", "x")` succeeds; `tmp_path / "a" / "b"` is created.
- `test_append_emits_logfire_span`: use `logfire.testing.CaptureLogfire` (or `pytest-logfire`'s capture); call `append`; assert exactly one span with attributes `vault.bytes_written == 6`, `vault.op_kind == "append"`. (If pydantic-ai's logfire test capture API has a different name, the implementer adapts.)
- `test_write_replace_is_atomic_on_success`: `write_replace(path, b"new content", vault_root=vault)` against an existing file with old content; assert path now reads `b"new content"`; assert `.staging/` is empty after the call.
- `test_write_replace_leaves_path_unchanged_on_fsync_failure`: monkeypatch `os.fsync` to raise; `write_replace` raises; original file content is unchanged; `.staging/` may contain the orphan `.tmp` (no cleanup expected on this path; sweep happens at startup).

- [ ] **3.1** Write `tests/test_vault_writer.py` with the six test cases. _(scott)_
- [ ] **3.2** Run the tests. Expect `ImportError` for `assistant.persistence.vault.writer`. _(scott)_
- [ ] **3.3** Implement `assistant/persistence/vault/writer.py` to satisfy the contract. Use `asyncio.to_thread` for the actual file I/O (open/write/fsync are blocking; the lock + the thread offload give correct serialization without blocking the event loop). _(scott)_
- [ ] **3.4** Run `uv run pytest tests/test_vault_writer.py -v`. All six pass. _(scott)_
- [ ] **3.5** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **3.6** Commit: `feat(persistence): vault writer with append, write_replace, and module-level Lock`. _(scott)_

### Task 4: Vault manifest

**Files:**
- Create: `assistant/persistence/vault/manifest.py`
- Test: `tests/test_vault_manifest.py`

**Contract.**

```python
class Entry(TypedDict):
    path: str          # vault-relative
    sha256: str        # of the on-disk file content; empty string for append-only kinds where the file is mutable
    bytes: int
    written_at: str    # ISO 8601 UTC microsecond
    extra: dict[str, Any]

class Manifest:
    """One Manifest instance per (vault_root, kind). Reads on construction;
    flushes after every successful set(). Phase 1 instantiates one per kind
    at app startup."""

    def __init__(self, vault_root: Path, kind: str) -> None: ...

    def get(self, key: str) -> Entry | None: ...
    def set(self, key: str, entry: Entry) -> None: ...  # persists via flush()
    def flush(self) -> None: ...                        # write to disk under writer's lock semantics
    def rebuild_from_vault(
        self, scanner: Callable[[Path], Iterator[tuple[str, Entry]]]
    ) -> None: ...
```

`key` is `str` (not `Hashable`); for transcripts the caller stringifies `(project, thread_id)` as `f"{project}:{thread_id}"`. Locking the key shape simplifies the on-disk JSON schema (it's just a string-keyed dict).

The on-disk file is `vault/.manifest/{kind}.json`, written via `writer.write_replace` to guarantee atomicity. The manifest is JSON `{"version": 1, "entries": {key: Entry, ...}}`.

**Tested by:**
- `test_manifest_get_returns_none_for_missing_key`.
- `test_manifest_set_then_get_round_trip`.
- `test_manifest_persists_across_instances`: set on instance A; instantiate instance B against the same vault_root + kind; B's `get(key)` returns the entry A set.
- `test_manifest_flush_uses_write_replace`: monkeypatch `writer.write_replace` to record calls; `manifest.flush()` invokes it exactly once with the manifest path and a JSON-encoded body.
- `test_manifest_rebuild_from_vault_replaces_entries`: pre-populate the manifest with stale entries; supply a scanner that yields different entries; `rebuild_from_vault` replaces the in-memory dict and flushes; reload from disk to confirm.

- [ ] **4.1** Write `tests/test_vault_manifest.py`. _(scott)_
- [ ] **4.2** Run the tests. Expect ImportError. _(scott)_
- [ ] **4.3** Implement `assistant/persistence/vault/manifest.py`. _(scott)_
- [ ] **4.4** Run `uv run pytest tests/test_vault_manifest.py -v`. All pass. _(scott)_
- [ ] **4.5** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **4.6** Commit: `feat(persistence): vault manifest with per-kind on-disk JSON`. _(scott)_

### Task 5: Transcript envelope models

**Files:**
- Create: `assistant/persistence/transcripts/__init__.py` (empty), `assistant/persistence/transcripts/events.py`
- Test: `tests/test_transcripts_envelope.py`

**Contract.**

Four pydantic models, all sharing a common base via composition (not inheritance, to keep the discriminator clean). The `kind` field is the discriminator; pydantic's `Field(discriminator=...)` shape on the `Event` union enforces it.

```python
from typing import Annotated, Literal
from pydantic import BaseModel, Field, RootModel
from pydantic_ai.messages import ModelMessage  # union of ModelRequest | ModelResponse

class ConversationStartEvent(BaseModel):
    uuid: str
    parent_uuid: None = None
    kind: Literal["conversation_start"] = "conversation_start"
    timestamp: str
    conversation_id: str
    project: str
    client: dict[str, str]   # {"name": str, "version": str}

class RunStartEvent(BaseModel):
    uuid: str
    parent_uuid: str
    kind: Literal["run_start"] = "run_start"
    timestamp: str
    conversation_id: str
    run_id: str
    is_sidechain: bool
    agent_name: str
    model: str
    instructions_sha256: str
    parent_run_id: str | None = None             # sidechain only
    triggering_tool_use_id: str | None = None    # sidechain only

class ModelMessageEvent(BaseModel):
    uuid: str
    parent_uuid: str
    kind: Literal["model_message"] = "model_message"
    timestamp: str
    conversation_id: str
    run_id: str
    is_sidechain: bool
    payload: ModelMessage           # pydantic-ai's discriminated union

class RunEndEvent(BaseModel):
    uuid: str
    parent_uuid: str
    kind: Literal["run_end"] = "run_end"
    timestamp: str
    conversation_id: str
    run_id: str
    is_sidechain: bool
    status: Literal["completed", "cancelled", "errored"]
    duration_ms: int

Event = Annotated[
    ConversationStartEvent | RunStartEvent | ModelMessageEvent | RunEndEvent,
    Field(discriminator="kind"),
]
```

Field names and the discriminator value strings match `docs/references/jsonl-transcript-format.md` §"Envelope schema (every line)" exactly. The `ModelMessage` type comes from `pydantic_ai.messages` (Task 1 confirmed the exact import path).

**Tested by:**
- `test_conversation_start_event_serializes`: build one; `model_dump(mode="json")` returns a dict with `kind == "conversation_start"`, `parent_uuid is None`.
- `test_run_start_event_sidechain_fields_optional`: `RunStartEvent(... is_sidechain=False ...)` does not require `parent_run_id` / `triggering_tool_use_id`; sets them to None.
- `test_run_start_event_sidechain_fields_required_when_sidechain`: building a sidechain `RunStartEvent` without those fields is allowed by the model (they're typed as Optional), but the encoder (Task 6) raises ValueError; tested in Task 6.
- `test_event_discriminated_parse_round_trip`: serialize one of each kind via `model_dump(mode="json")`; parse via `pydantic.TypeAdapter(Event).validate_python(d)`; equality holds.
- `test_model_message_event_carries_pydantic_ai_payload`: build a `ModelRequest` with a `UserPromptPart`; wrap in `ModelMessageEvent(... payload=request)`; serialize; round-trip; assert the request equals the original.

- [ ] **5.1** Write `tests/test_transcripts_envelope.py`. _(scott)_
- [ ] **5.2** Run the tests. Expect ImportError. _(scott)_
- [ ] **5.3** Implement `assistant/persistence/transcripts/events.py`. _(scott)_
- [ ] **5.4** Run `uv run pytest tests/test_transcripts_envelope.py -v`. All pass. _(scott)_
- [ ] **5.5** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **5.6** Commit: `feat(transcripts): envelope models for the four JSONL event kinds`. _(scott)_

### Task 6: Encoder

**Files:**
- Create: `assistant/persistence/transcripts/encoder.py`
- Test: `tests/test_transcripts_encoder.py`

**Contract.**

```python
def encode_conversation_start(
    *, conversation_id: str, project: str, client_name: str, client_version: str,
    started_at: datetime, id_factory: Callable[[], str],
) -> str:
    """Build a ConversationStartEvent; return its JSON line (no trailing newline).
    The writer adds the newline."""

def encode_run_start(
    *, parent_uuid: str, conversation_id: str, run_id: str, is_sidechain: bool,
    agent_name: str, model: str, instructions: str, now: datetime,
    id_factory: Callable[[], str],
    parent_run_id: str | None = None, triggering_tool_use_id: str | None = None,
) -> str:
    """Build a RunStartEvent. Computes instructions_sha256 = sha256(instructions.encode()).hexdigest().
    If is_sidechain is True, parent_run_id and triggering_tool_use_id are required;
    raises ValueError if missing."""

def encode_model_message(
    *, parent_uuid: str, conversation_id: str, run_id: str, is_sidechain: bool,
    message: ModelMessage, now: datetime, id_factory: Callable[[], str],
) -> str:
    """Build a ModelMessageEvent wrapping `message`. The payload uses
    message.model_dump(mode="json") under the hood via pydantic."""

def encode_run_end(
    *, parent_uuid: str, conversation_id: str, run_id: str, is_sidechain: bool,
    status: Literal["completed", "cancelled", "errored"],
    duration_ms: int, now: datetime, id_factory: Callable[[], str],
) -> str:
    """Build a RunEndEvent."""
```

All encoders return `event.model_dump_json(exclude_none=True)`. `exclude_none=True` keeps the JSONL line minimal (sidechain-only fields don't appear on main-conversation events).

The encoder does not call the writer. It returns the line; the recorder (Task 8) is responsible for writing.

**Tested by:**
- `test_encode_conversation_start_shape`: known inputs produce the expected JSON line (parsed and compared as dict, not string-compared).
- `test_encode_run_start_computes_instructions_sha256`: passing `instructions="hi"` produces a line whose `instructions_sha256 == sha256(b"hi").hexdigest()`.
- `test_encode_run_start_main_omits_sidechain_fields`: `is_sidechain=False` produces a line where `parent_run_id` and `triggering_tool_use_id` are absent (not null).
- `test_encode_run_start_sidechain_requires_linkage_fields`: `is_sidechain=True` without `parent_run_id` raises `ValueError`.
- `test_encode_model_message_request_round_trips`: encode a `ModelRequest` with a `UserPromptPart("hello")`; parse the resulting line back into a dict; assert `payload["kind"] == "request"` and the part shape matches Task 1's verified `part_kind`.
- `test_encode_model_message_response_round_trips`: encode a `ModelResponse` with a `TextPart("world")`; assert `payload["kind"] == "response"` and `payload["parts"][0]["part_kind"]` matches Task 1's verified value.
- `test_encode_run_end_main_omits_sidechain_fields`: as for run_start.

- [ ] **6.1** Write `tests/test_transcripts_encoder.py`. _(scott)_
- [ ] **6.2** Run the tests. Expect ImportError. _(scott)_
- [ ] **6.3** Implement `assistant/persistence/transcripts/encoder.py`. _(scott)_
- [ ] **6.4** Run `uv run pytest tests/test_transcripts_encoder.py -v`. All pass. _(scott)_
- [ ] **6.5** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **6.6** Commit: `feat(transcripts): encoder for the four event kinds with sha256 instructions hash`. _(scott)_

### Task 7: Decoder + reader + round-trip integration

**Files:**
- Create: `assistant/persistence/transcripts/decoder.py`, `assistant/persistence/transcripts/reader.py`
- Test: `tests/test_transcripts_decoder.py`, `tests/test_transcripts_reader.py`, `tests/test_transcripts_roundtrip.py`

**Contract.**

```python
# decoder.py
def decode_line(line: str) -> Event:
    """Parse one JSONL line into the discriminated Event union via
    pydantic.TypeAdapter(Event). Raises ValueError on JSON parse error or
    schema-validation failure. Reader tolerates these per the reader policy."""

# reader.py
@dataclass(frozen=True)
class ReaderStats:
    truncated_lines: int      # tail line failed JSON parse
    unknown_parts: int        # ModelMessage parts with unrecognized part_kind, dropped
    unknown_events: int       # whole event with unrecognized kind, skipped
    orphan_run_starts: int    # run_start with no matching run_end
    total_lines_seen: int

def read_conversation(
    vault_root: Path, project: str, thread_id: str,
) -> tuple[list[ModelMessage], ReaderStats]:
    """Read the JSONL file for (project, thread_id). Iterate lines; decode each;
    apply the reader policy from docs/references/jsonl-transcript-format.md
    §"Reader policy". Return:
      1. The list[ModelMessage] reconstructed from model_message events where
         is_sidechain == False (sidechain messages are excluded from the main
         conversation's message_history).
      2. ReaderStats with counts of each tolerated condition.

    Raises FileNotFoundError if the file does not exist.
    Raises PermissionError if the file is not readable."""
```

The reader does not consult the manifest for the file path; the caller (recorder / handler) resolves the path. The reader is read-only; it never writes.

**Tested by:**

`tests/test_transcripts_decoder.py`:
- `test_decode_line_round_trips_each_kind`: encode one of each event kind via Task 6 encoders; `decode_line(encoded)` returns the equivalent event model (pydantic equality).
- `test_decode_line_invalid_json_raises_value_error`: `decode_line("not json")` raises `ValueError`.
- `test_decode_line_schema_failure_raises_value_error`: `decode_line('{"kind":"made_up","uuid":"x"}')` raises `ValueError`.

`tests/test_transcripts_reader.py`:
- `test_reader_returns_empty_list_for_only_lifecycle`: a JSONL containing only `conversation_start` returns `([], ReaderStats(total_lines_seen=1, ...))`.
- `test_reader_tolerates_truncated_trailing_line`: hand-write a JSONL whose last line is half a JSON object; reader returns the prior valid messages; `ReaderStats.truncated_lines == 1`.
- `test_reader_tolerates_unknown_event_kind`: pre-populate a file with one valid `model_message` line and one synthetic `{"kind":"future_kind", ...}` line; reader returns the one message; `unknown_events == 1`.
- `test_reader_excludes_sidechain_messages`: pre-populate a file with one main-run `model_message` and one sidechain `model_message`; reader returns only the main one.
- `test_reader_orphan_run_start_counted`: a JSONL with `run_start` but no matching `run_end` increments `orphan_run_starts`; the messages emitted before the missing end are still returned.
- `test_reader_raises_file_not_found_for_missing_file`: `read_conversation(vault, "x", "nonexistent")` raises `FileNotFoundError`.

`tests/test_transcripts_roundtrip.py` (the integrity guarantee from `jsonl-transcript-format.md` §"Encode / decode round-trip"):
- `test_roundtrip_user_prompt`: build a `ModelRequest` with one `UserPromptPart("hello")`; encode → decode → pydantic equality holds.
- `test_roundtrip_text_response`: `ModelResponse` with `TextPart`; round-trip.
- `test_roundtrip_tool_call_and_return`: a `ModelResponse` with `ToolCallPart(tool_name="x", args={"a":1}, tool_call_id="tu1")`, then a `ModelRequest` with `ToolReturnPart(tool_name="x", content="ok", tool_call_id="tu1")`; both round-trip individually.
- `test_roundtrip_thinking_part`: `ModelResponse` with `ThinkingPart("reasoning...")`; round-trip.
- `test_roundtrip_retry_prompt`: `ModelRequest` with `RetryPromptPart(...)`; round-trip.
- `test_roundtrip_system_prompt`: `ModelRequest` with `SystemPromptPart("you are helpful")`; round-trip.
- `test_roundtrip_multimodal_user_prompt`: a `UserPromptPart` whose `content` is a list mixing `str` and `BinaryContent(data=b"...", media_type="image/png")`; round-trip; the binary content is inlined (no `.aux/` writes at phase 1 per spec §D9).

The implementer adds further round-trip cases if Task 1's probe surfaced part kinds not in this list.

- [ ] **7.1** Write `tests/test_transcripts_decoder.py`. _(scott)_
- [ ] **7.2** Run the tests. Expect ImportError. _(scott)_
- [ ] **7.3** Implement `assistant/persistence/transcripts/decoder.py`. _(scott)_
- [ ] **7.4** Run decoder tests. Pass. _(scott)_
- [ ] **7.5** Write `tests/test_transcripts_reader.py`. _(scott)_
- [ ] **7.6** Run reader tests. Expect ImportError. _(scott)_
- [ ] **7.7** Implement `assistant/persistence/transcripts/reader.py`. _(scott)_
- [ ] **7.8** Run reader tests. Pass. _(scott)_
- [ ] **7.9** Write `tests/test_transcripts_roundtrip.py`. _(scott)_
- [ ] **7.10** Run round-trip tests. All pass (or the implementer adjusts Task 1's reference doc and the encoder if a part-kind discriminator was wrong). _(scott)_
- [ ] **7.11** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **7.12** Commit: `feat(transcripts): decoder, tolerant reader, encode-decode round-trip across part kinds`. _(scott)_

### Task 8: Recorder

**Files:**
- Create: `assistant/persistence/transcripts/recorder.py`
- Test: `tests/test_transcripts_recorder.py`

**Contract.**

The recorder is the high-level API the FastAPI handlers use. It owns the manifest entry per conversation and resolves the file path. It does not own the agent; it observes runs.

```python
class TranscriptRecorder:
    def __init__(
        self,
        *,
        vault_root: Path,
        client_name: str = "assistant",
        client_version: str,            # from importlib.metadata.version("assistant")
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        id_factory: Callable[[], str] = lambda: ulid.new().str,
    ) -> None: ...

    async def ensure_conversation_started(
        self, *, project: str, conversation_id: str,
    ) -> Path:
        """Returns the conversation file path. If the manifest has no entry
        for (project, conversation_id), creates one: appends a conversation_start
        event with started_at = clock(), records the manifest entry with
        path, started_at, run_count=0. Returns the path either way."""

    async def run_start(
        self, *, path: Path, conversation_id: str, run_id: str,
        is_sidechain: bool, agent_name: str, model: str, instructions: str,
        parent_run_id: str | None = None, triggering_tool_use_id: str | None = None,
    ) -> str:
        """Append a run_start event. Returns the event's uuid (so the next
        event can set parent_uuid)."""

    async def append_messages(
        self, *, path: Path, conversation_id: str, run_id: str,
        is_sidechain: bool, messages: list[ModelMessage], parent_uuid: str,
    ) -> str:
        """Append one model_message event per message. Returns the uuid of
        the last event appended."""

    async def run_end(
        self, *, path: Path, conversation_id: str, run_id: str,
        is_sidechain: bool, status: Literal["completed", "cancelled", "errored"],
        duration_ms: int, parent_uuid: str,
    ) -> None: ...
```

The recorder calls `writer.append` once per line. It also updates the manifest entry's `run_count` after each `run_end`. It does not maintain in-memory state per conversation beyond what the manifest holds; restarting the process loses no information.

**Tested by:**
- `test_recorder_creates_file_on_first_run`: call `ensure_conversation_started` then `run_start` then `append_messages([request, response])` then `run_end(status="completed", ...)`; the file at the returned path contains exactly 5 lines in order (conversation_start, run_start, model_message×2, run_end), and each line parses via `decode_line`.
- `test_recorder_does_not_duplicate_conversation_start`: call `ensure_conversation_started` twice for the same (project, thread_id); file has exactly one `conversation_start` line.
- `test_recorder_uuid_chain_is_correct`: assert each line's `parent_uuid` equals the previous line's `uuid` (causal chain).
- `test_recorder_id_factory_is_used`: pass a counter-backed `id_factory`; assert the uuids in the file match the counter sequence.
- `test_recorder_clock_is_used`: pass a frozen clock returning `2026-05-23T14:30:12+00:00`; assert every event's `timestamp` is exactly that ISO string.
- `test_recorder_run_count_increments_in_manifest`: after two complete runs, the manifest entry for (project, thread_id) has `extra["run_count"] == 2`.
- `test_recorder_handles_cancelled_status`: call `run_end(status="cancelled", duration_ms=...)`; the run_end event has `status == "cancelled"`.

- [ ] **8.1** Write `tests/test_transcripts_recorder.py`. _(scott)_
- [ ] **8.2** Run the tests. Expect ImportError. _(scott)_
- [ ] **8.3** Implement `assistant/persistence/transcripts/recorder.py`. _(scott)_
- [ ] **8.4** Run recorder tests. Pass. _(scott)_
- [ ] **8.5** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **8.6** Commit: `feat(transcripts): recorder API for conversation, run, and message lifecycle`. _(scott)_

### Task 9: Wire `/chat/sync` (server-canonical history + capture)

**Files:**
- Modify: `assistant/app.py`
- Test: `tests/test_app_chat_sync_capture.py`, `tests/test_app_server_canonical_history.py`

**Contract.**

`/chat/sync` now accepts:

```python
class ChatSyncRequest(BaseModel):
    message: str
    thread_id: str | None = None     # missing => server generates a fresh one
    project: str | None = None       # missing => settings.DEFAULT_PROJECT
```

Response shape gains a `thread_id` field so the client can pass it back next turn:

```python
{"output": "...", "thread_id": "..."}
```

Handler flow:

1. Resolve `project` (request value or `Settings.DEFAULT_PROJECT`); call `validate_project_name`; raise 422 on failure (FastAPI's standard pydantic-error path).
2. Resolve `thread_id` (request value or `uuid4()`).
3. Call `recorder.ensure_conversation_started(project=..., conversation_id=thread_id)` to get the file path.
4. Read history: `messages, _stats = reader.read_conversation(vault_root, project, thread_id)`.
5. `run_id = ulid.new().str`; capture `started_at = datetime.now(tz=UTC)`.
6. `recorder.run_start(path=..., run_id=run_id, is_sidechain=False, agent_name="main", model=settings_model_string(), instructions=agent.system_prompt(), ...)` (the instructions string is whatever the Agent will pass through to its first ModelRequest; phase 1's Agent has a static instructions string).
7. `result = await agent.run(body.message, conversation_id=thread_id, message_history=messages)`.
8. `recorder.append_messages(..., messages=result.new_messages(), ...)`.
9. `recorder.run_end(..., status="completed", duration_ms=(now - started_at).total_seconds() * 1000, ...)`.
10. Return `{"output": result.output, "thread_id": thread_id}`.

`app.py` dependency-injects a process-singleton `TranscriptRecorder` via a new `get_recorder(settings)` factory; the test seam mirrors `get_agent` (override at `app.dependency_overrides[get_recorder]` for tests that want to count writer calls).

**Tested by:**

`tests/test_app_chat_sync_capture.py`:
- `test_chat_sync_writes_jsonl_on_first_call`: POST to `/chat/sync` with a body containing `message`; response body has `thread_id`; the file at the recorder's computed path exists and contains 5 lines (conversation_start, run_start, model_message×2, run_end).
- `test_chat_sync_appends_to_existing_conversation_on_second_call`: POST twice with the same `thread_id`; second POST does not add a second `conversation_start`; total `run_start` count is 2.
- `test_chat_sync_uses_settings_default_project_when_unset`: with `Settings.DEFAULT_PROJECT="custom"`, POST without a `project` field; the file lives under `vault/transcripts/custom/...`.
- `test_chat_sync_rejects_invalid_project`: POST with `project=".."`; response is 422.
- `test_chat_sync_response_includes_thread_id`: POST without a `thread_id`; response body has a non-empty `thread_id`.

`tests/test_app_server_canonical_history.py`:
- `test_chat_sync_replays_prior_messages_to_agent`: prepopulate a JSONL with two prior turns; POST a new message with the matching `thread_id`; assert (via a TestModel that captures `message_history` passed to it) that the agent received the two prior turns.
- `test_chat_sync_ignores_client_supplied_messages`: this test does not apply to `/chat/sync` (the wire shape doesn't include `messages`); move-along.

- [ ] **9.1** Write `tests/test_app_chat_sync_capture.py` and `tests/test_app_server_canonical_history.py`. _(scott)_
- [ ] **9.2** Run the tests. Expect failures (handler doesn't yet wire the recorder). _(scott)_
- [ ] **9.3** Modify `assistant/app.py` to wire the recorder into `/chat/sync` per the contract. Add `get_recorder` dependency factory. _(scott)_
- [ ] **9.4** Run the two new test files. All pass. _(scott)_
- [ ] **9.5** Run full suite. Phase-0 carryovers still pass; phase 1 tests pass. _(scott)_
- [ ] **9.6** Run ruff + mypy. Clean. _(scott)_
- [ ] **9.7** Commit: `feat(app): /chat/sync captures transcripts and reads server-canonical history`. _(scott)_

### Task 10: Wire `/chat` AG-UI (manual flow + cancellation)

**Files:**
- Modify: `assistant/app.py`, `assistant/client.py`
- Test: `tests/test_app_chat_ag_ui_capture.py`, `tests/test_app_cancellation.py`

**Contract.**

`/chat` drops from `AGUIAdapter.dispatch_request` to the manual flow chosen in Task 1's `## AG-UI capture path` section of the reference doc. The handler must satisfy this behavioral contract regardless of which branch Task 1 selected:

- Resolve `project` from the AG-UI request body. The AG-UI spec leaves the carrier open; the implementer picks among `RunAgentInput.context`, a top-level body field, or a query param, and documents the choice in `NOTES.md`. Apply `validate_project_name`; reject with 422 on failure. Fall back to `Settings.DEFAULT_PROJECT` when absent.
- Use `run_input.thread_id` as the `conversation_id`. Call `recorder.ensure_conversation_started` to obtain the file path and write the `conversation_start` event on first POST for this thread.
- Read server-canonical history via `reader.read_conversation(vault_root, project, thread_id)`. Pass that history to the agent as `message_history=...`. The new user turn is `run_input.messages[-1]`; the earlier client-supplied messages are ignored.
- Append a `run_start` event before driving the agent; record the run's start time for `duration_ms` measurement.
- Drive the agent through the manual `AGUIAdapter` flow (`build_run_input` → `AGUIAdapter(agent, run_input, accept)` → `.run_stream()` → `.encode_stream()`) so AG-UI SSE events stream to the client unchanged. The wire format of `/chat` is unchanged from phase 0; phase 0's smoke tests must still pass.
- After the response body fully drains, capture the run's `ModelMessage` list (mechanism per branch, below), append one `model_message` event per message, then append a `run_end` event with `status: "completed"` and the measured `duration_ms`. FastAPI's `BackgroundTask` attached to the `StreamingResponse` is one mechanism that fits; the implementer may choose another that gives the same post-drain semantics.

**Branch A** applies when Task 1 confirmed the `AGUIAdapter` instance exposes the just-completed run's messages after `run_stream()` drains (whether named `.result.all_messages()`, `.result.new_messages()`, `.last_run`, or another shape). The capture surface is that single call. This is the simpler path: usage stats, tool calls, thinking parts, and the full part taxonomy land in the JSONL intact.

**Branch B** applies when Task 1 confirmed no such attribute exists. The handler taps the AG-UI event stream as it iterates: accumulate `TextMessageContent` deltas into a buffer and, on `RunFinished`, synthesize one `ModelResponse` with a single `TextPart` containing the assembled text, plus one `ModelRequest` carrying a `UserPromptPart` with `run_input.messages[-1].content`. Capture is degraded (no tool calls, no thinking parts, no usage stats), acceptable for phase 1 because there are no tools and no thinking-capable model wired by default. The reference doc records this trade-off.

**Cancellation contract** (both branches): if the client disconnects mid-stream, `asyncio.CancelledError` propagates through the response generator. The handler must catch at the outer level, compute `duration_ms` from the captured start time, append whatever messages the capture surface can provide (Branch A: the result's available messages, possibly partial; Branch B: a synthetic `ModelResponse` with the partial assembled text if any was streamed before the cancel), append a `run_end` event with `status: "cancelled"`, then re-raise `CancelledError`. Per spec §"What's locked by the progression plan", cancellation must preserve the user message and any pre-cancellation assistant content; the user's `ModelRequest` must therefore be appended before the `run_end`.

**Tested by:**

`tests/test_app_chat_ag_ui_capture.py`:
- `test_chat_ag_ui_writes_jsonl_after_response_drains`: POST a `RunAgentInput`; assert the SSE response arrives (existing phase-0 smoke-test pattern); after the response is fully consumed, the JSONL file exists at the recorder path and contains the expected line sequence.
- `test_chat_ag_ui_uses_settings_default_project`: as for sync.
- `test_chat_ag_ui_reads_server_canonical_history`: prepopulate JSONL with prior turns; POST a new `RunAgentInput` with the matching `thread_id`; assert (via TestModel capture) that the agent received the prior history.
- `test_chat_ag_ui_ignores_client_messages_beyond_latest`: the `RunAgentInput.messages` list contains 3 client messages; the server uses only the last as the new turn and reconstructs the rest from JSONL. (Assert by setting JSONL prior messages to a distinctive marker the client did not send and confirming the agent received that marker via TestModel.)

`tests/test_app_cancellation.py`:
- `test_chat_ag_ui_cancellation_writes_run_end_with_status_cancelled`: drive the AG-UI request through `httpx.ASGITransport`; abort the stream mid-flight (close the response context); wait briefly; assert the JSONL has a `run_end` event with `status == "cancelled"`.
- `test_chat_ag_ui_cancellation_preserves_user_message`: same setup; assert the `model_message` event for the user's request was written before the `run_end`. (Per spec: "Cancellation must preserve user message and any pre-cancellation assistant content".)

- [ ] **10.1** Re-read Task 1's `## AG-UI capture path` decision in `jsonl-transcript-format.md`. Pick Branch A or Branch B accordingly. _(scott)_
- [ ] **10.2** Write `tests/test_app_chat_ag_ui_capture.py` and `tests/test_app_cancellation.py`. _(scott)_
- [ ] **10.3** Run the tests. Expect failures. _(scott)_
- [ ] **10.4** Modify `assistant/app.py` to implement the chosen branch. The existing `dispatch_request` line is replaced. The `ChatSyncRequest`-style request typing for `/chat` is not introduced (AG-UI's `RunAgentInput` is the request body); project comes from `run_input.context` per the AG-UI spec (a context object) or via the body's top-level. (Implementer: check the reference doc; if the AG-UI body lacks a clean place, fall back to a query param `?project=...` and document this in NOTES.) _(scott)_
- [ ] **10.5** Modify `assistant/client.py`: `AssistantClient.stream_chat(message, *, thread_id: str | None = None, project: str | None = None)`. `thread_id` defaults to `str(uuid.uuid4())` (current behavior). `project`, if supplied, is sent via the body or query param matching whatever the server expects after 10.4. _(scott)_
- [ ] **10.6** Run AG-UI capture tests. Pass. _(scott)_
- [ ] **10.7** Run cancellation tests. Pass. (If the cancellation path is hard to trigger via httpx, the implementer may simulate by directly calling the handler's cancellation branch with a synthetic CancelledError raise; document the test approach in the docstring.) _(scott)_
- [ ] **10.8** Run full suite. Phase-0 smoke tests (`test_smoke.py`) still pass; phase-0 client test (`test_client.py`) still passes (the `thread_id`/`project` kwargs are optional). _(scott)_
- [ ] **10.9** Run ruff + mypy. Clean. _(scott)_
- [ ] **10.10** Commit: `feat(app): /chat captures transcripts via manual AGUIAdapter flow with cancellation support`. _(scott)_

### Task 11: Client adapter `project` and `thread_id` kwargs

**Files:**
- Modify: `assistant/client.py` (continuation of Task 10 if any)
- Test: `tests/test_client.py` (extend, not replace)

**Contract.** `AssistantClient.stream_chat` signature:

```python
async def stream_chat(
    self, message: str, *, thread_id: str | None = None, project: str | None = None,
) -> AsyncIterator[str]: ...
```

Backwards-compatible: existing callers passing only `message` still work; `thread_id` defaults to a fresh UUID; `project` defaults to None (server applies its default).

**Tested by (additions to `tests/test_client.py`):**
- `test_stream_chat_uses_supplied_thread_id`: pass a fixed `thread_id`; assert the server saw exactly that thread_id (verified by inspecting the recorded JSONL).
- `test_stream_chat_passes_project_when_supplied`: pass `project="custom"`; the JSONL file lands under `vault/transcripts/custom/...`.

- [ ] **11.1** If Task 10 already covered this, skip Task 11 entirely and note "covered by Task 10" in the commit log; otherwise: extend `assistant/client.py` and add the two tests. _(scott)_
- [ ] **11.2** Run `uv run pytest tests/test_client.py -v`. New tests pass; existing tests still pass. _(scott)_
- [ ] **11.3** Run full suite + ruff + mypy. Clean. _(scott)_
- [ ] **11.4** Commit (if changes): `feat(client): accept thread_id and project kwargs`. _(scott)_

### Task 12: Documentation

**Files:** `assistant/README.md`, `assistant/CHANGELOG.md`, `assistant/NOTES.md`, `docs/plans/python-llm-app-progression.md` (in scratch/).

**Contract.**

- `assistant/README.md`: a new short section "Transcripts" after the chat section. Three sentences: where transcripts land (`vault/transcripts/...`); that the server is canonical (no client-side history bookkeeping needed); a pointer to `docs/references/jsonl-transcript-format.md` for the format. One code-block example showing two successive `assistant.client` calls with the same `thread_id` to demonstrate continuity.
- `assistant/CHANGELOG.md`: `## [0.1.0] - <merge-date>` entry. Bullets: JSONL transcripts at `vault/transcripts/{project}/{date}/{thread8}.jsonl`; vault-write primitives (writer + manifest + lock + paths); server-canonical conversation state via `conversation_id == thread_id`; both `/chat` and `/chat/sync` capture; `Settings.DEFAULT_PROJECT`; `assistant.client.stream_chat` gains `thread_id` and `project` kwargs.
- `assistant/NOTES.md`: new section `## Transcript persistence + vault-write primitives`. Concept: **server-canonical state.** Body: the client sends a thread_id and the latest user message; the server reads the JSONL for that thread_id and reconstructs the conversation; the client never needs to track history. Pointers to `assistant/persistence/vault/writer.py` (primitives), `assistant/persistence/transcripts/recorder.py` (orchestration), `docs/references/jsonl-transcript-format.md` (format), `docs/references/vault-write-primitives.md` (cross-phase contract). Single follow-up callout: phase 2's semantic recall walks every conversation's JSONL.
- `docs/plans/python-llm-app-progression.md` (in scratch): update the phase 1 `Artifacts.` line to mark "merged in `assistant/` on <date>" once Task 13 squash-merges. Deferred to Task 13's last step.

- [ ] **12.1** Edit `assistant/README.md`. _(scott)_
- [ ] **12.2** Edit `assistant/CHANGELOG.md`. _(scott)_
- [ ] **12.3** Edit `assistant/NOTES.md`. _(scott)_
- [ ] **12.4** Commit: `docs: README, CHANGELOG, NOTES for transcript persistence`. _(scott)_

### Task 13: Local CI + I5 verification + remote push + merge

**Files:** none for code; `docs/plans/python-llm-app-progression.md` for the progression update.

**Contract.**

- Local CI sim exits 0 on every step: `uv sync && uv run ruff check && uv run ruff format --check && uv run mypy assistant && uv run pytest`.
- §I5 invariant survives. Logfire spans appear for both Agent runs AND vault-write operations. Manual probe: with `LOGFIRE_TOKEN` set, start uvicorn, POST a `/chat/sync` request, confirm in Logfire that (a) the Agent-run span still appears (phase-0 carryover), and (b) at least one `vault.append` span appears for the same request. If the writer's span doesn't appear, the implementer fixes before merging.
- Manifest rebuild dry-run: write a small one-off script (do not commit) that calls `manifest.rebuild_from_vault(...)` against the dev vault and confirms the rebuilt manifest equals the on-disk one. This catches scanner bugs before they bite in production.
- Push `feat/transcripts`. Remote CI passes on first push. If CI fails, fix and re-push; do not merge red.
- Squash-merge to `main` via PR.
- After merge, in `scratch/`: update the progression plan's `## Phase 1` `Artifacts.` line to include "merged YYYY-MM-DD in `assistant/`". Commit on scratch's main.

- [ ] **13.1** Run the local CI sim; all five commands exit 0. _(scott)_
- [ ] **13.2** Walk §08 Acceptance; tick every box. _(scott)_
- [ ] **13.3** Manual I5 probe: with `LOGFIRE_TOKEN` set, POST `/chat/sync`; confirm Agent span + at least one `vault.append` span in Logfire. _(scott)_
- [ ] **13.4** Manifest rebuild dry-run against the dev vault. _(scott)_
- [ ] **13.5** Push the branch: `git push -u origin feat/transcripts`. _(scott)_
- [ ] **13.6** Wait for remote CI green. If red, fix and re-push. _(scott)_
- [ ] **13.7** Squash-merge to `main` via PR. _(scott)_
- [ ] **13.8** In `scratch/`: update progression plan's phase 1 Artifacts line; commit. _(scott)_

## 07. Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| `AGUIAdapter` does not expose a result object after `run_stream` drains. Branch A from Task 10 is unbuildable. | High | Plausible | Task 1's probe decides early. Branch B (event-stream tap) is the documented fallback; it captures degraded but valid transcripts. |
| The manual `AGUIAdapter` flow rejects `conversation_id` / `message_history` kwargs at `run_stream`. The server can't pass server-canonical history through the AG-UI path. | High | Plausible | If true, the handler bypasses `AGUIAdapter.run_stream` and drives `agent.iter()` manually, then re-encodes events to AG-UI shape via `adapter.encode_stream`. Pre-authorized by `01-ag-ui-migration.md` ADR D4. Task 10 documents the fallback path in the reference doc. |
| Logfire's `gen_ai.*` namespace conflicts with our `vault.*` attribute names; spans get attribute-stripped or rejected. | Low | Unlikely | Task 1.6 confirms the namespacing matches `logging_setup.py`. If a conflict surfaces in Task 3, rename to `vault.<op>.bytes` etc. before the writer commit. |
| `fsync` on every `append` is slow enough that streaming responses become visibly choppy. | Medium | Possible | The writer runs `fsync` inside `asyncio.to_thread`; the event loop is not blocked. If perception lag is reported during dev usage, profile and consider batching (per-run flush) as a phase 2 amendment, not a phase 1 rework. |
| The asyncio.Lock module-singleton creates serialization bottleneck under concurrent requests (e.g., browser opens two tabs against the same thread). | Low | Low | Phase 1 is single-user-single-tab. The lock holds for the duration of one write (a few ms). Bench in Task 13.3 if curious; revisit at phase 6+ when tool calls multiply per-turn writes. |
| The reader's "tolerate truncated trailing line" policy hides a real corruption bug (writer is silently truncating mid-line on every call). | Medium | Unlikely | The reader logs every tolerated condition via Logfire; Task 13.4 (rebuild dry-run) compares rebuilt-from-disk to manifest. Frequent tolerations would surface in Logfire and in the rebuild diff. |
| `python-ulid` produces collision-prone IDs under high concurrency (extremely unlikely; ULID's 80 bits of entropy make collisions astronomical). | Low | Negligible | ULID's monotonic guarantee within a process is what we need for chronological sort. Acceptable. |
| `Settings.DEFAULT_PROJECT` shipping in phase 1 introduces a config flag we later regret. | Low | Low | The default ("default") is safe forever; any future caller-supplied project takes precedence. No data migration would be needed even if we removed the field. |
| The 8-char thread_id prefix in filenames collides for two same-second conversations. | Low | Very unlikely | UUIDv4 first 8 hex = 32 bits; collision probability at one new conversation per second is ~10⁻⁹. If it ever fires, the manifest's full thread_id key disambiguates; the file with the older `started_at` keeps its name and the new one increments a counter suffix (implementer adds this only if it ever fires). |
| The implementer hits a pydantic-ai serialization edge case Task 1 didn't probe (e.g., a `BinaryContent` containing 50 MB and we inline it). | Medium | Possible | Phase 1 has no real path for users to attach 50 MB. If the implementer hits it in Task 7's round-trip suite, file a follow-up issue and skip the offending test with an `xfail` reason that points at phase 6 (tool returns) or phase 3 (large dynamic instructions) as the first real consumer. |
| §I5 regression: vault writes happen but no Logfire span is emitted (silent observability gap). | Medium | Unlikely | Task 3 covers this with `test_append_emits_logfire_span`; Task 13.3 verifies end-to-end. |

## 08. Acceptance

- [ ] `feat/transcripts` branched off `main`'s phase 0 final squash commit (PF4). _(scott)_
- [ ] `pyproject.toml` has `python-ulid` in dependencies. _(scott)_
- [ ] `Settings.DEFAULT_PROJECT` exists; tests cover both the default and an override. _(scott)_
- [ ] `assistant/persistence/vault/paths.py` exposes `validate_project_name`, `resolve_vault_root`, `conversation_path`. _(scott)_
- [ ] `assistant/persistence/vault/writer.py` exposes async `append` and `write_replace`, both using one module-level `asyncio.Lock`. _(scott)_
- [ ] `assistant/persistence/vault/manifest.py` exposes `Manifest` with `get`/`set`/`flush`/`rebuild_from_vault`. _(scott)_
- [ ] `assistant/persistence/transcripts/events.py` defines the four envelope models with discriminated union. _(scott)_
- [ ] `assistant/persistence/transcripts/encoder.py` exposes the four `encode_*` functions. _(scott)_
- [ ] `assistant/persistence/transcripts/decoder.py` exposes `decode_line`. _(scott)_
- [ ] `assistant/persistence/transcripts/reader.py` exposes `read_conversation` returning `(list[ModelMessage], ReaderStats)`. _(scott)_
- [ ] `assistant/persistence/transcripts/recorder.py` exposes `TranscriptRecorder` with the four-method surface. _(scott)_
- [ ] `assistant/app.py` `/chat/sync` reads server-canonical history and writes transcripts. _(scott)_
- [ ] `assistant/app.py` `/chat` reads server-canonical history and writes transcripts via the manual AGUIAdapter flow (the branch chosen in Task 1). _(scott)_
- [ ] `assistant/app.py` `/chat` handles client disconnect: emits `run_end` with `status: "cancelled"` and preserves any pre-cancellation assistant content. _(scott)_
- [ ] `assistant/client.py` `AssistantClient.stream_chat` accepts optional `thread_id` and `project` kwargs (backwards-compatible). _(scott)_
- [ ] All new tests pass: `pytest tests/test_vault_paths.py tests/test_vault_writer.py tests/test_vault_manifest.py tests/test_transcripts_envelope.py tests/test_transcripts_encoder.py tests/test_transcripts_decoder.py tests/test_transcripts_reader.py tests/test_transcripts_recorder.py tests/test_transcripts_roundtrip.py tests/test_app_chat_sync_capture.py tests/test_app_chat_ag_ui_capture.py tests/test_app_server_canonical_history.py tests/test_app_cancellation.py -v` exits 0. _(scott)_
- [ ] Phase 0 carryover tests still pass: `pytest tests/test_smoke.py tests/test_client.py tests/test_agent.py tests/test_config.py tests/test_fixtures.py tests/test_logging_setup.py -v` exits 0. _(scott)_
- [ ] `uv run ruff check` exits 0. _(scott)_
- [ ] `uv run ruff format --check` exits 0. _(scott)_
- [ ] `uv run mypy assistant` exits 0. _(scott)_
- [ ] `docs/references/jsonl-transcript-format.md` has `last-verified` set, `pydantic-ai-pin` set, a `## Sample lines` section filled in, and a `## AG-UI capture path` section recording the chosen branch. _(scott)_
- [ ] `docs/references/vault-write-primitives.md` has `last-verified` set. _(scott)_
- [ ] §I5 invariant verified: a `/chat/sync` request produces both the Agent-run span and at least one `vault.append` span in Logfire when `LOGFIRE_TOKEN` is set. _(scott)_
- [ ] `assistant/README.md` has a "Transcripts" section. _(scott)_
- [ ] `assistant/CHANGELOG.md` has a `[0.1.0]` entry. _(scott)_
- [ ] `assistant/NOTES.md` has a `## Transcript persistence + vault-write primitives` section. _(scott)_
- [ ] Squash-merge landed on `assistant/main`; remote CI green. _(scott)_
- [ ] `docs/plans/python-llm-app-progression.md` (scratch) phase 1 Artifacts line updated with merge date. _(scott)_

## 09. Out of scope (from spec §"What's outside phase 1")

These do not have tasks in this plan and will not block acceptance:

- Markdown view of JSONL.
- `.aux/<sha256>` spill-to-file write logic. (Shape defined in encoder; no writes.)
- Edit-feedback from Obsidian.
- Multi-process write coordination.
- Pruning, archival, compaction.
- CLI subcommands (`assistant transcripts list/replay/export`).
- Provenance markers.

## 10. Open questions (surface, do not resolve here)

These are noted for the next planning round; they don't block phase 1 implementation.

- **Mirror `02-post-scaffold-iteration.md` to `scratch/docs/plans/`?** Currently scratch has `00-` and `01-`, this plan is `03-`. The gap is intentional (the iteration retrospective was implementer-authored) but worth resolving before phase 2 planning so the sequence reads cleanly.
- **CLAUDE.md `NN` convention update.** CLAUDE.md says NN is the phase number; practice has NN as the plan-sequence index. The phase 1 plan filename is `03-transcripts.md`. Worth a CLAUDE.md amendment.
- **Markdown view of JSONL utility.** A future `assistant transcripts view <thread_id>` that renders JSONL to readable markdown. Phase 5 (eval harness) may want this; otherwise defer to whoever needs it first.
- **Provenance markers timing.** Master progression §10 placed these at phase 1; spec §D8 deferred to phase 3. Confirm in phase 3 planning that the memory writer is the right first consumer.
