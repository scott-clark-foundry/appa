---
title: "Vault-write primitives"
status: draft
introduced: phase 1
consumers: phase 1 (transcripts), phase 3 (memory), phase 4 (SKILL.md), phase 8 (skill drafts), phase 10 (self-improvement)
last-verified: 2026-05-24
---

# Vault-write primitives

Cross-phase contract for **any** file that goes into the vault. Defined once at phase 1; every later phase that writes uses these primitives — never the raw filesystem. The primitives are protocol-agnostic: they take bytes (or lines) and write them safely. They don't know about JSONL, markdown frontmatter, or any specific content shape.

## Purpose

Every phase that touches the vault needs three things:

1. **Atomicity** — a crash mid-write must not leave a half-written file.
2. **Serialization** — concurrent writers (foreground chat, background extraction, background skill drafting) must not race.
3. **Visibility** — the implementer (and the operator) needs to know which writes have happened and what shape they took.

The primitives below provide all three. Phase 1 ships the writer + manifest + lock. Phase 3+ adds consumers without redesigning the primitives.

## API surface

### Writer

```python
class WriteResult:
    path: Path
    bytes_written: int
    op_kind: Literal["append", "write_replace"]
    latency_ms: float


async def append(path: Path, line: str) -> WriteResult:
    """Append one line + '\n' to path. Acquires the lock, fsync per call.

    No staging. A crash mid-write leaves at most one truncated trailing line;
    readers tolerate this (treat as truncation, recover prior state).

    Used by phase 1 for JSONL transcript events.
    """

async def write_replace(path: Path, data: bytes) -> WriteResult:
    """Atomically replace path's content with `data`.

    Sequence under the lock: write to `vault/.staging/<filename>.tmp`, fsync,
    rename to `path`. Update the manifest with the new sha256 and size.

    Not used at phase 1. Defined now so phase 3+ memory amendments, phase 4
    SKILL.md writes, and phase 8 skill drafts inherit atomic semantics
    without redesign.
    """
```

### Manifest

The manifest is a per-content-kind map of `key → entry`. Phase 1's consumer (transcripts) declares its own key shape; phase 3+ consumers declare theirs. The manifest module exposes a generic interface.

```python
class Entry(TypedDict):
    path: str                # vault-relative
    sha256: str
    bytes: int
    written_at: str          # ISO timestamp
    extra: dict[str, Any]    # consumer-specific (transcripts puts run_count, last_event_uuid here)


def get(kind: str, key: Hashable) -> Entry | None:
    """Look up an entry. Returns None if absent."""

def set(kind: str, key: Hashable, entry: Entry) -> None:
    """Insert or replace. Persists on next flush."""

def flush() -> None:
    """Write the on-disk manifest. Called after every successful writer op."""

def rebuild_from_vault(kind: str, scanner: Callable[[Path], Iterator[tuple[Hashable, Entry]]]) -> None:
    """Recovery: rebuild this kind's entries by walking the filesystem.

    Each `kind` has its own scanner. The transcripts scanner walks
    `vault/transcripts/**/*.jsonl`, reads the `conversation_start` event
    of each file, and yields `((project, thread_id), entry)`.
    """
```

The on-disk manifest is `vault/.manifest/<kind>.json`. Phase 1 ships `transcripts.json`. Phase 3+ ships `memory.json`, etc. Each `kind` is independent; no cross-kind locking, no cross-kind invariants.

### Paths

```python
def resolve_vault_root() -> Path:
    """Read Settings.VAULT_PATH, validate writable, fail-fast on missing.

    Called once at app startup. Cached for the process lifetime.
    """

def staging_dir() -> Path:
    """vault/.staging — sweep orphan .tmp files on startup."""

def manifest_path(kind: str) -> Path:
    """vault/.manifest/{kind}.json"""

def aux_path(sha256: str) -> Path:
    """vault/transcripts/.aux/{sha256} — phase 1 reserves the location;
    writes deferred to first consumer."""
```

### Lock

Single module-level `asyncio.Lock` in the writer module. Both `append` and `write_replace` acquire it. No public API beyond the writer functions — the lock is an implementation detail of "all vault writes serialize."

**Why `asyncio.Lock` (not `anyio.Lock`)** — verified 2026-05-24: FastAPI/uvicorn is asyncio-native (the writer is called from `async def` handlers running on the asyncio event loop). pydantic-ai uses `anyio` internally for its own primitives, but the boundary it exposes to callers is plain `async def`, which composes cleanly with `asyncio.Lock` on either backend. `anyio.Lock` would add a dependency the writer doesn't need, and `anyio.Lock` running under asyncio's loop just delegates to `asyncio.Lock` anyway. Revisit if a phase introduces trio compatibility or directly schedules the writer onto a non-asyncio anyio backend.

## Invariants

These hold across every consumer phase. Violating any of them is a phase-level regression.

- **Single writer.** All vault writes go through `append` or `write_replace`. No direct `open(path, "w")` or `path.write_bytes()` calls in any phase. Caught by lint rule (writing-plans phase decides which).
- **`append` is fsynced per line.** When `append` returns, the line is on disk. A subsequent crash does not lose that line.
- **`write_replace` is atomic.** When `write_replace` returns successfully, either the new content is fully visible at `path` or `path` is unchanged. No intermediate state.
- **Manifest is a cache, not a source of truth.** If the manifest disagrees with the filesystem, `rebuild_from_vault` resolves to the filesystem.
- **VAULT_PATH validation is startup-only.** The app refuses to start if the vault root is missing or unwritable. Runtime writes assume the root is good; transient failures during writes (disk full, permission flip) are logged and re-raised.
- **One Logfire span per writer op.** Span attributes: `vault.path` (vault-relative), `vault.bytes_written`, `vault.latency_ms`, `vault.op_kind` (`append` or `write_replace`). Satisfies §I5 for the persistence layer. Verified 2026-05-24 against `assistant/logging_setup.py`: the only existing instrumentation is `logfire.instrument_pydantic_ai()` (emits OpenTelemetry GenAI `gen_ai.*` spans around `Agent.run` automatically); the `vault.*` namespace does not collide. Operators see both span families side-by-side: `gen_ai.*` for what the model did, `vault.*` for what was written.
- **Staging files (`.tmp`) are swept at startup.** Any `.tmp` file in `vault/.staging/` older than process start time is removed. Crashes during `write_replace` leave .tmp orphans; sweep cleans up.
- **No multi-process coordination.** Single-process assumption. A second process writing the same vault races the in-process lock — undefined behavior, out of scope until a phase explicitly addresses it.

## Consumer phase-by-phase

| Phase | Consumer | Primary op | Notes |
|---|---|---|---|
| 1 | Transcript recorder | `append` | One line per pydantic-ai `ModelMessage` + lifecycle markers. Manifest kind `transcripts`, key `(project, thread_id)`. |
| 3 | Memory writer | `write_replace` | One markdown file per entry under `vault/memory/`. Manifest kind `memory`, key `entry_name`. Activates the provenance markers deferred at phase 1. |
| 4 | Skills writer | `write_replace` | One SKILL.md per skill under `vault/skills/`. Manifest kind `skills`, key `skill_name`. |
| 8 | Skill drafter | `write_replace` | Drafts to `vault/skills/_staging/`. Same writer; same lock; same manifest. |
| 10 | Self-improvement | both | Reads (via the JSONL reader) + writes (via either primitive). |

## What's not in this contract

- **Content shape.** JSONL framing, markdown frontmatter conventions, Skills-spec frontmatter — all live in the consumer-phase docs or in `jsonl-transcript-format.md`.
- **Read APIs.** This doc is the *write* surface. The JSONL reader for transcripts is documented in `jsonl-transcript-format.md`. Memory / skills readers come in their own phase docs.
- **Provenance markers** (`^[inferred]`, `^[ambiguous]`, frontmatter ratios). Deferred to phase 3 where the first consumer exists.
- **`.patch.md` proposed-diff primitive.** Deferred to first consumer (phase 3+ memory amendments).
