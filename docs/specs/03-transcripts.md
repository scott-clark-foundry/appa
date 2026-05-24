---
phase: 1
progression-plan: ../plans/python-llm-app-progression.md#l1
status: draft
slug: transcripts
branch: feat/transcripts
---

# Phase 1 spec: `feat/transcripts`

## Intent

Land the first persistence layer. Every pydantic-ai `Agent.run()` from either of the chat endpoints (`/chat` AG-UI streaming, `/chat/sync` plain JSON) produces a replay-grade JSONL record under `vault/transcripts/{project}/{YYYY-MM-DD}/{thread_id-short}.jsonl`. Stand up the **vault-write primitives** (writer + manifest + asyncio.Lock + staging-then-atomic-rename) that every later phase reuses for any vault write. Make the **server canonical** for conversation state: the chat handler reconstructs `message_history` from the JSONL and feeds it to `Agent.run(..., conversation_id=thread_id)`. The client's `messages` array beyond the latest user message is ignored.

The progression plan describes phase 1 in §#l1 and the vault-write primitives in §10 (cross-cutting patterns). This spec captures the JSONL-vs-markdown decision, the AG-UI capture strategy (which the progression plan couldn't anticipate), the multi-wire capture story, and the precise scope of which primitives ship now vs are deferred.

## What's locked by the progression plan

These are inherited, not re-decided here.

- One file per session at session end (§#l1), reinterpreted as one file per conversation (`thread_id`) given the AG-UI thread/run model; see `§D3`.
- `vault/transcripts/{YYYY-MM-DD}/...` storage layout (§#l1), extended with a project bucket above the date dir per `§D3`.
- Vault-write primitives introduced at this phase: manifest with SHA-256 delta tracking, staging directory, provenance markers (§10). Scope adjusted in `§D8`: provenance deferred to phase 3; staging-as-`.patch.md` deferred to phase 3+ (phase 1 uses staging only for atomic-rename, not for proposed diffs).
- Single in-process writer; all vault writes serialize through one lock (§10).
- Cancellation must preserve user message and any pre-cancellation assistant content (§#l1). Mechanism in `§D6`.
- Logfire instrumentation on the Agent layer (§I5) survives this phase; the writer additionally emits one Logfire span per write.
- Phase 0 acceptance is preserved; nothing regresses. The two endpoints currently shipping in `assistant/app.py` (`/chat` AG-UI, `/chat/sync` plain JSON, per `assistant/docs/plans/02-post-scaffold-iteration.md` Iteration C) both gain transcript capture; neither's wire format changes.

## What's outside phase 1 (deferred deliberately)

- **Markdown view of a JSONL.** Acknowledged future utility (e.g. `assistant transcripts view <thread_id>`) that renders a JSONL to a readable markdown file. Not phase 1; phase 1 ships the JSONL only.
- **`.aux/<sha256>` spill-to-file logic.** Shape defined (`binary_ref`, `instructions_ref`) so later phases inherit a verified shape without redesign, but the actual store-to-`.aux/` code does not ship now. First real consumer (tool-produced binaries at phase 6, possibly large dynamic instructions earlier) wires it up.
- **Edit-feedback from Obsidian.** The JSONL is the source of truth. A user editing a derived markdown view (when it ships) does not feed back into the agent's context at phase 1.
- **Multi-process write coordination.** A second process attempting to write the same vault would race the in-process lock. Out of scope; single-user, single-process assumption holds.
- **Pruning, archival, compaction.** The vault grows monotonically.
- **CLI subcommands** (`assistant transcripts list`, `replay`, `export`). Phase 5's eval harness may build some of these; phase 1 doesn't.
- **Provenance markers** (`^[inferred]`, `^[ambiguous]`). Deferred to phase 3 per `§D8`.

## Decisions made during phase-1 brainstorming

### D1: JSONL, not markdown, for transcripts

Replay-grade, append-friendly, machine-readable. The earlier draft proposed markdown transcripts; that conflated "transcript" with "human-browsable view." JSONL is the canonical record; a markdown view is a derived utility (deferred). Markdown is reserved for what it actually fits: memory files (AGENTS.md-style always-loaded; memGPT-style hot/cold; the [cline](https://github.com/cline/cline) Memory Bank pattern), SKILL.md files, subagent definitions, and other agent-managed structured prose.

**Rejected:** markdown transcripts with append-only sections (would need re-rewrite of whole file to update frontmatter; conflates record-of-truth with reader-friendly view; can't easily carry `BinaryContent`, `ThinkingPart`, tool-call args, retries, or other structured part kinds).

### D2: Server-canonical conversation state

On a POST to `/chat` (or `/chat/sync`), the server is the authoritative source of conversation history. It reads the JSONL for the thread, deserializes every `kind: "model_message"` event back into a `ModelRequest | ModelResponse`, and passes the list as `message_history=` to `Agent.run(latest_user_message, conversation_id=thread_id, ...)`. The request body's `messages` array beyond the latest user message is ignored.

This is the documented use case for pydantic-ai's `conversation_id` parameter: the docs say to pass "an ID from your own application (such as a chat thread ID from your database)" and `conversation_id == AG-UI thread_id` is exactly that. Verified via context7 against pydantic-ai 1.102.

**Rejected:** client-canonical (trust whatever `messages` the client sends; server is just a recorder). Loses to client-state-drift: if the browser refreshes or the CLI client doesn't track history, the agent sees an inconsistent or empty context. Server-canonical is robust.

**Hybrid (server reads, validates against request, reconciles divergence)** is also rejected as more machinery than phase 1 needs.

### D3: One file per conversation, project-grouped, date-bucketed under project

```
vault/transcripts/
  default/                              ← project (default)
    2026-05-23/
      2026-05-23T143012-thread-a3f8.jsonl
      2026-05-23T151245-thread-b9d2.jsonl
  agent-builder/                        ← project (caller-named)
    2026-05-23/
      2026-05-23T091534-thread-c1e7.jsonl
  .manifest/
    transcripts.json
  .staging/
  .aux/                                 ← (phase 1) shape only; no writes yet
```

Mirrors Claude Code's `~/.claude/projects/<encoded-cwd>/<conversation-uuid>.jsonl` shape. Project is the top-level grouping; date dir under each project keeps any one directory navigable; filename starts with `started_at` for chronological sort and ends with the first 8 hex chars of `thread_id` to disambiguate same-second creation.

**Rejected:** flat dir with full UUID filenames (Obsidian-hostile, no grouping). Per-conversation directory (overkill at this scope). Year/month sub-bucketing (premature for a personal-scale vault).

### D4: Project source — client-adapter parameter + config default

Project name comes from the client. Three concrete paths:

1. Python `AssistantClient.stream_chat(message, project=...)` adds a `project` kwarg; the client adapter includes it in the AG-UI request `context` field.
2. `/chat/sync` accepts an optional `project` field in the JSON body (defaults to the server-side default).
3. The server-side default is read from `Settings.DEFAULT_PROJECT` (defaults to `"default"`).

Server validates the project string against a path-safe regex (alphanumeric + dash + underscore; no slashes, no leading dots) before using it in a path.

**Rejected:** project derived from `cwd` (server has no client-cwd context). HTTP header `X-Project` (not part of AG-UI; adds out-of-band metadata; client-adapter param is more discoverable).

### D5: Per-message append granularity

One line in the JSONL per `ModelMessage` (one per `ModelRequest`, one per `ModelResponse`), plus three lifecycle events (`conversation_start`, `run_start`, `run_end`) per run. Each line written with one `write()` + `fsync()` under the writer lock.

**Why not batch per run** (accumulate `result.new_messages()` in memory, one fsync at run_end): a crash mid-run loses the entire run. Per-message granularity means a crash leaves a valid prefix; readers tolerate the trailing potentially-truncated line and continue.

**Why not finer than per-message** (per-part or per-token): pydantic-ai's `ModelMessage` is the natural unit. Re-feeding partial messages back via `message_history=` is unsupported.

### D6: Cancellation is a `run_end` event with `status: "cancelled"`

When the client disconnects mid-stream during `/chat` AG-UI, the agent's task raises `asyncio.CancelledError`. The handler catches, queries whatever `result.new_messages()` is available (the final assistant message may be partial), appends those `model_message` events, then appends a `run_end` event with `status: "cancelled"` and `duration_ms` measured from `run_start`.

**Rejected:** distinct `kind: "run_cancelled"` event (more event kinds; `status` field on `run_end` disambiguates without adding to the taxonomy).

### D7: Capture path differs by wire

Two wires, two capture strategies, one shared recorder.

**`/chat/sync` is trivial.** Handler does `result = await agent.run(body.message, conversation_id=thread_id, message_history=server_history)`. After the await returns, `result.new_messages()` is right there. Encode → append. Done. The same `conversation_id` plumbing applies.

**`/chat` AG-UI requires dropping to the manual `AGUIAdapter` flow.** `AGUIAdapter.dispatch_request(request, agent=agent)` (currently used in `assistant/app.py`) is opaque — we don't get access to `result.all_messages()` from the response. pydantic-ai's docs (verified via context7 against 1.102) describe a manual flow:

```python
run_input = AGUIAdapter.build_run_input(await request.body())
adapter = AGUIAdapter(agent=agent, run_input=run_input, accept=accept)
event_stream = adapter.run_stream()            # we can tap this
sse_event_stream = adapter.encode_stream(event_stream)
return StreamingResponse(sse_event_stream, media_type=accept)
```

This drop-down is pre-authorized by the AG-UI migration plan's ADR D4 ("drop to the manual flow if a request-size limit, per-thread quota, or per-request auth check needs to fire before the agent runs"). Phase 1's transcript capture invokes that authorization.

The remaining question — does `adapter` expose `result.all_messages()` after the stream completes, or do we tap the event stream and reconstruct ModelMessages from events — is implementation-level. The plan's Task 1 investigates against the live pydantic-ai 1.102. If `adapter.result` is exposed, that's the simpler path. If not, the event-stream tap is the fallback; either way, the recorder consumes the same encoded JSONL events.

**Rejected:** logfire-instrumentation-as-source (couples transcript capture to logfire being enabled; loses transcripts when `LOGFIRE_TOKEN` is unset). Server-side tee of the SSE response bytes (parsing our own output is ugly and brittle). Drop `dispatch_request` entirely in favor of the manual flow (acceptable, since we're dropping to manual for capture anyway; the plan locks this).

### D8: Vault-write primitives scope (writer + manifest + lock + paths only)

Phase 1 ships:

- **`writer.append(path, line)`** — acquire lock, open in append mode, write `line + "\n"`, fsync, release. No staging (a partial trailing line is a recoverable state for the reader).
- **`writer.write_replace(path, bytes)`** — acquire lock, write to `vault/.staging/<filename>.tmp`, fsync, atomic rename to target path, update manifest, release. **Not used by phase 1**; defined now so phase 3+ memory amendments inherit the atomic semantics without redesign.
- **`manifest.get(key)` / `manifest.set(key, entry)` / `manifest.rebuild_from_vault()`** — `(project, thread_id) → entry` lookup. JSON-on-disk at `vault/.manifest/transcripts.json`. Rebuild is the corruption-recovery path: scan all conversation JSONL headers (`conversation_start` events) and reconstruct.
- **`paths.resolve_vault_root()`** — read `Settings.VAULT_PATH`, validate writable, fail-fast on missing.
- **Single module-level `asyncio.Lock`** shared by `append` and `write_replace`.
- **One Logfire span per write** (`path`, `bytes_written`, `latency_ms`, `op_kind`).

Phase 1 does **not** ship:

- **Provenance markers** (`^[inferred]`, `^[ambiguous]`, frontmatter ratios). Deferred to phase 3 where they're first used (memory write provenance). No skeleton module now.
- **`.patch.md` proposed-diff primitive** (the master plan §10 mention of "staging directory + `.patch.md` files"). Designing the patch shape against zero usage usually misses something a real use case would have forced; defer until phase 3+ memory amendments need it.
- **`.aux/<sha256>` writes.** Shape defined in `§D9`; no writes at phase 1.

**Rejected:** ship everything from §10 now (would design `.patch.md` and provenance without a consumer). Ship even less (writer + lock only; no manifest, no rebuild) — manifest is needed at phase 1 itself for `(project, thread_id)` lookup on every POST.

### D9: `.aux/<sha256>` shape defined, writes deferred

When a part's content is binary or large (above a threshold to be set when needed), the encoder replaces the inline content with a content-addressed reference:

```json
{"part_kind":"user_prompt","content":[
  {"type":"text","text":"Here's the screenshot:"},
  {"type":"binary_ref","sha256":"abc...","media_type":"image/png","size":102400}
]}
```

The bytes live at `vault/transcripts/.aux/<sha256>`. Content-addressed: identical artifacts dedupe automatically. The same pattern supports `instructions_ref: {sha256, preview}` for large dynamic instructions (phase 3+).

Phase 1 defines the `binary_ref` / `instructions_ref` shape and reserves the `.aux/` location. Phase 1 does **not** implement the spill-to-aux logic; binary content (if any) is inlined and the encode/decode round-trip is verified. First real consumer (phase 6 tool returns with `BinaryContent`, or phase 3 large dynamic instructions, whichever lands first) wires it.

### D10: Subagent (sidechain) events in the same file as the parent

When a tool call invokes another `Agent.run()` (a subagent), each run gets its own `run_id`. The subagent's events are written into the same JSONL file as the parent conversation, with `is_sidechain: true`. Linkage:

- `run_start` for the sidechain carries `parent_run_id` (the outer run's id) and `triggering_tool_use_id` (the `ToolCallPart.tool_call_id` that spawned the subagent).
- All `model_message` events for the sidechain carry `is_sidechain: true` and their own `run_id`.
- The outer run's events keep `is_sidechain: false`; they're interleaved chronologically with the sidechain's events in the same file.
- The outer run's eventual `tool_result` (a `ToolReturnPart`) appears as a `model_message` event after the sidechain's `run_end`.

Mirrors Claude Code's `isSidechain` flag in `~/.claude/projects/*/<uuid>.jsonl`. One file = one user-visible conversation, with all subagent activity included.

**Rejected:** separate file per subagent run (more files; cross-references get unwieldy; reading the conversation requires opening multiple files). Inline subagent events into the parent's `tool_result` payload (loses chronological ordering; loses the ability to scrub through subagent reasoning over time).

## Open questions

These are noted for the writing-plans phase. None block the spec.

- **Does `AGUIAdapter` expose `result.all_messages()` after `run_stream()` completes?** Plan Task 1 investigates. If yes, simpler capture; if no, event-stream tap + reconstruct.
- **`message_history` reconstruction lossiness.** Encode → JSONL → decode → pass to `Agent.run(message_history=...)` must round-trip. Plan covers this with an explicit integration test against every `part_kind`.
- **Should `02-post-scaffold-iteration.md` be mirrored in `scratch/docs/plans/`?** The retrospective was authored implementer-side. Scratch currently has `00-` and `01-` only. Not part of phase 1, but worth resolving before the next phase begins to keep the plan-sequence numbering coherent. Asked separately.
- **`Settings.DEFAULT_PROJECT` field.** New config field; defaults to `"default"`. Should it land as part of phase 1 or be a separate scaffold-level iteration? Plan decides.

## Pointers

- Master progression: `../plans/python-llm-app-progression.md#l1` (phase 1 scope), §10 (vault-write primitives).
- Phase 0 (init): `../plans/00-init-scaffold.md`, this spec's `§D1`-`§D4`.
- Phase 0 amendment (AG-UI): `../plans/01-ag-ui-migration.md`. The migration plan's ADR D4 authorizes the manual `AGUIAdapter` drop-down phase 1 invokes.
- Phase 0 retrospective: `/Users/scott/projects/assistant/docs/plans/02-post-scaffold-iteration.md` (implementer-side; not mirrored in scratch yet). Iteration C added `/chat/sync` — both wires now need transcript capture.
- Live `assistant/` source: `assistant/app.py` (the two endpoints), `assistant/client.py` (AG-UI streaming consumer), `assistant/config.py` (multi-provider Settings.build_model()), `assistant/docs/references/ag-ui-surface.md` (pydantic-ai pin, verified field names, event-name strings).
- Cross-phase contracts seeded by this phase: `../references/vault-write-primitives.md`, `../references/jsonl-transcript-format.md`.
- Steering material (not canonical, per Scott): `docs/assistant-phases/phase-1-{brief,architecture,plan}.md`.
