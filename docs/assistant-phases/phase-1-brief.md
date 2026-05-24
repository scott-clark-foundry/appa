---
title: brief · phase 1 · feat/transcripts
phase: 1
branch: feat/transcripts
tier: service
---

# Brief: phase 1 · feat/transcripts

**Tier:** service

**Goal.** Persist completed and cancelled chat turns to markdown under `vault/transcripts/{date}/{session}.md`, and stand up the vault-write primitives (manifest, staging, provenance markers) that every later phase will reuse.

**Starting state.** Init commit has shipped:

- pydantic-ai Agent (zero tools), FastAPI app with one SSE chat endpoint, in-memory conversation only
- Logfire instrumentation enabled for all LLM calls (I5)
- Vault paths created but empty: `memory/`, `skills/`, `evals/`, `transcripts/`
- ruff + mypy + CI green; one smoke test (chat round-trip); one eval fixture format
- ADR-001 (pydantic-ai owns the model layer; no direct provider SDK imports), ADR-002 (FastAPI on every phase), ADR-003 (one growing assistant), ADR-005 (one repo, one main)

**Inputs.**

- Turn events emitted by the in-memory chat loop (user message, assistant response, cancellation signal on disconnect)
- Session metadata: session id, start time, model string
- Vault root path from config

**Outputs.**

- Markdown files at `vault/transcripts/{YYYY-MM-DD}/{session}.md`, one per session (completed or cancelled)
- A manifest tracking written transcripts with content hashes
- A vault-write primitives module exposing manifest, staging-then-rename, and provenance markers as reusable APIs for later phases
- An architecture.md section: "persistence and vault-write primitives"

**Done criteria.**

- Persistence round-trip test: a recorded turn writes to markdown that re-parses to equivalent content
- Cancellation test: disconnecting mid-turn produces a `[cancelled]` marker in the transcript without losing the user message or already-streamed assistant tokens
- Idempotency test: two runs against the same vault state do not rewrite unchanged transcripts (manifest hash check)
- Full CI green; eval suite extended with at least one transcript-related fixture
- CHANGELOG entry under `## [unreleased]`; NOTES.md section explaining the one concept this phase teaches
- No regression in earlier capabilities

**Non-goals.**

- Search, retrieval, or indexing over transcripts (Phase 2)
- Editing or amending past transcripts after write
- Encryption at rest
- A separate browsing UI; markdown files in the vault are the browse surface
- Multi-process write coordination beyond a single in-process writer

**Persistence.**

- Filesystem only. Markdown files plus a manifest. No database in this phase.
- Manifest tracks path, SHA-256 of file content, and `written_at` timestamp per transcript.
- Every file write goes through staging-then-atomic-rename so a crash leaves the file either fully present or absent, never partial.

**Where it runs.** Author's laptop, single process, macOS or Linux. No deployment surface in this phase.

**Constraints.**

- Python at the version pinned in init's `pyproject.toml`; dependencies limited to what's already locked unless a new dep is justified in architecture.md
- All LLM calls continue to route through pydantic-ai per ADR-001 and I9
- Logfire tracing continues to capture file writes (path, size, latency) per I5
- Vault stays a plain folder of files; nothing Obsidian-specific in core code
- Transcripts do not carry agent-readable instructions, so I6 (Skills-spec compliance) does not bind their format; if frontmatter is added for indexing, it must not collide with Skills-spec keys

**Failure tolerance.**

- Cancellation mid-turn: write the partial turn with `[cancelled]` marker; preserve the user message and any assistant tokens that streamed before disconnect
- Crash mid-write: atomic rename guarantees no half-written transcripts; staging directory is swept on next start
- Concurrent writes: a single in-process writer (lock or queue) serializes vault writes. Foreground chat is the only writer at Phase 1; later phases add background writers that must use the same serialization point.

**Open questions (left to the subagent).**

- Manifest format: JSON, SQLite, or markdown table. Document the choice in an ADR.
- Session id scheme: uuid, timestamp+nonce, or other.
- Transcript markdown layout: frontmatter shape, turn separator convention, how to render streamed-but-incomplete assistant output.
