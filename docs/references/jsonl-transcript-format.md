---
title: "JSONL transcript format"
status: seed — refine in plan 03 Task N against the live import
introduced: phase 1 (`docs/specs/03-transcripts.md`)
pydantic-ai-pin: ">=1.102,<2"  # matches assistant/docs/references/ag-ui-surface.md
consumers: phase 1 (write+read), phase 2 (read for indexing), phase 3 (subscribe via bus), phase 5 (replay), phase 8 (read for pattern mining), phase 10 (read)
last-verified: null
---

# JSONL transcript format

The on-disk record of every pydantic-ai `Agent.run()` the assistant performs. One file per conversation (`thread_id`), append-only, one JSON object per line. Every event from a run lands here; replay of a conversation is a matter of streaming the JSONL.

> [!NOTE] Status
> Planner seed. Phase 1's plan refines this doc against the live pydantic-ai 1.102 surface: confirms exact `part_kind` discriminator values, confirms `RequestUsage` field names, captures a redacted real-encoded sample of every part kind under test. `last-verified` is set when the implementer finishes refinement.

## Why this format

pydantic-ai's `Agent.run()` returns a result whose `.all_messages()` is an ordered list of `ModelRequest | ModelResponse`. Each carries the full structured detail of one request/response cycle — parts (text, tool calls, tool returns, thinking, retries, multimodal content), usage, model name, timestamps, run_id, conversation_id, instructions. This format **wraps each `ModelMessage` in a thin envelope** so we get:

- Replay: feed the deserialized messages list back into `Agent.run(message_history=...)`.
- Append-only durability: one line per ModelMessage, one fsync per append.
- Cross-conversation linkage: subagent (sidechain) runs in the same file as their parent.
- Reference shapes for large content (`binary_ref`, `instructions_ref`) without forcing inline storage.

## File layout

```
vault/transcripts/
  {project}/                          ← `default` if caller doesn't specify
    {YYYY-MM-DD}/                     ← derived from started_at on conversation_start
      {YYYYMMDDTHHMMSS}-{thread8}.jsonl
  .manifest/
    transcripts.json                  ← (project, thread_id) → entry
  .staging/                           ← writer's atomic-rename area
  .aux/                               ← content-addressed aux store
    {sha256}                          ← bytes referenced by binary_ref / instructions_ref
```

- One file per `thread_id`. Filename starts with `started_at` (UTC compact ISO) for chronological sort; ends with the first 8 hex chars of `thread_id` for collision-resistance.
- `{project}` is caller-supplied (Python adapter param `project=`, `/chat/sync` JSON field `project`), defaults to `"default"`. Path-safe regex: `^[a-zA-Z0-9_-]{1,64}$`.

## Event kinds

Four kinds. The first three are lifecycle markers; only `model_message` carries pydantic-ai content.

### `conversation_start`

Written once per conversation, on the first POST that creates the thread.

```json
{
  "uuid": "01JFAB-0001",
  "parent_uuid": null,
  "kind": "conversation_start",
  "timestamp": "2026-05-23T14:30:12.482Z",
  "conversation_id": "thread-a3f8...",
  "project": "default",
  "client": {"name": "assistant.client", "version": "0.0.3"}
}
```

### `run_start`

Written at the start of each `Agent.run()` (main run or sidechain).

```json
{
  "uuid": "01JFAB-0002",
  "parent_uuid": "01JFAB-0001",
  "kind": "run_start",
  "timestamp": "2026-05-23T14:30:13.000Z",
  "conversation_id": "thread-a3f8...",
  "run_id": "run-001",
  "is_sidechain": false,
  "agent_name": "main",
  "model": "openai:gpt-5-nano",
  "instructions_sha256": "3f9a..."
}
```

For sidechain runs, the envelope additionally carries `parent_run_id` (the outer run that called the tool) and `triggering_tool_use_id` (the `ToolCallPart.tool_call_id` of the call that spawned this sidechain):

```json
{
  "uuid": "01JFAB-0011",
  "parent_uuid": "01JFAB-0010",
  "kind": "run_start",
  "conversation_id": "thread-a3f8...",
  "run_id": "run-003",
  "is_sidechain": true,
  "parent_run_id": "run-002",
  "triggering_tool_use_id": "tu-001",
  "agent_name": "notes_searcher",
  "model": "openai:gpt-5-nano",
  "instructions_sha256": "b2c1..."
}
```

`instructions_sha256` is the sha256 of the `instructions` string that will appear in the run's first `ModelRequest`. Phase 1 inlines instructions in the request payload; later phases may swap to `instructions_ref` (see `§Reference shapes`) when instructions grow large.

### `model_message`

One per `ModelRequest | ModelResponse` from `result.all_messages()` / `result.new_messages()`. The `payload` is a serialized ModelMessage — phase 1 uses pydantic-ai's own JSON serialization (via `model_dump(mode="json")`) so that `model_validate(payload)` round-trips.

```json
{
  "uuid": "01JFAB-0003",
  "parent_uuid": "01JFAB-0002",
  "kind": "model_message",
  "timestamp": "2026-05-23T14:30:13.001Z",
  "conversation_id": "thread-a3f8...",
  "run_id": "run-001",
  "is_sidechain": false,
  "payload": {
    "kind": "request",
    "parts": [
      {"part_kind": "user_prompt", "content": "What's on my calendar tomorrow?", "timestamp": "2026-05-23T14:30:13.001Z"}
    ],
    "instructions": "You are a helpful assistant. Today is 2026-05-23."
  }
}
```

```json
{
  "uuid": "01JFAB-0004",
  "parent_uuid": "01JFAB-0003",
  "kind": "model_message",
  "timestamp": "2026-05-23T14:30:13.890Z",
  "conversation_id": "thread-a3f8...",
  "run_id": "run-001",
  "is_sidechain": false,
  "payload": {
    "kind": "response",
    "parts": [
      {"part_kind": "text", "content": "I don't have calendar access yet, but I can help you plan around what you tell me."}
    ],
    "usage": {"input_tokens": 42, "output_tokens": 21, "total_tokens": 63},
    "model_name": "gpt-5-nano",
    "finish_reason": "stop"
  }
}
```

### `run_end`

Written when `Agent.run()` returns (clean) or raises `asyncio.CancelledError` (mid-stream disconnect on `/chat`).

```json
{
  "uuid": "01JFAB-0005",
  "parent_uuid": "01JFAB-0004",
  "kind": "run_end",
  "timestamp": "2026-05-23T14:30:13.891Z",
  "conversation_id": "thread-a3f8...",
  "run_id": "run-001",
  "is_sidechain": false,
  "status": "completed",
  "duration_ms": 890
}
```

`status` is `"completed"` | `"cancelled"` | `"errored"`. Cancellation produces a `run_end` with `status: "cancelled"`; the `model_message` events that landed before the cancel are present in the file (per the per-message append granularity in `docs/specs/03-transcripts.md` §D5).

## Envelope schema (every line)

| Field | Type | Notes |
|---|---|---|
| `uuid` | str | Event identifier in our store. ULID-shaped recommended (sortable). Not the pydantic-ai run_id. |
| `parent_uuid` | str \| null | Previous event in causal chain. `null` only on `conversation_start`. |
| `kind` | `"conversation_start"` \| `"run_start"` \| `"model_message"` \| `"run_end"` | Discriminator. |
| `timestamp` | str (ISO 8601, UTC, microsecond) | When the event was recorded. |
| `conversation_id` | str | pydantic-ai's conversation_id; equals AG-UI thread_id (see `docs/specs/03-transcripts.md` §D2). |
| `run_id` | str | pydantic-ai's run_id. Absent only on `conversation_start`. |
| `is_sidechain` | bool | True for subagent events. Absent only on `conversation_start`. |
| `parent_run_id` | str (sidechain only) | The outer run that called the tool. |
| `triggering_tool_use_id` | str (sidechain `run_start` only) | The `ToolCallPart.tool_call_id` that spawned this sidechain. |
| `project` | str (on `conversation_start` only) | Inherited by every event in the file. |
| `client` | object (on `conversation_start` only) | `{name, version}`. |
| `agent_name` | str (on `run_start` only) | "main" for the conversation's top-level agent; subagent name for sidechains. |
| `model` | str (on `run_start` only) | Provider:model string at run start. |
| `instructions_sha256` | str (on `run_start` only) | sha256 of the instructions in the run's first ModelRequest. |
| `status` | str (on `run_end` only) | `"completed"` \| `"cancelled"` \| `"errored"`. |
| `duration_ms` | int (on `run_end` only) | Wall clock from `run_start` to `run_end`. |
| `payload` | object (on `model_message` only) | Serialized `ModelRequest` or `ModelResponse`. See `§Payload schema`. |

## Payload schema (kind = `model_message`)

Serialized `ModelRequest` or `ModelResponse` from pydantic-ai. Use `pydantic_ai.messages.ModelMessage` (the union) for parsing: `ModelMessagesTypeAdapter.validate_python(payload)` if pydantic-ai exposes it, otherwise direct `ModelRequest.model_validate` / `ModelResponse.model_validate` discriminated on `payload["kind"]`.

### Common fields

- `kind`: `"request"` | `"response"`.
- `parts`: list of part objects; see `§Part taxonomy`.

### Request-only fields

- `instructions`: str. The (potentially dynamic) instructions for this request. Per `docs/specs/03-transcripts.md` §D9, may swap to `instructions_ref` when large.

### Response-only fields

- `usage`: `{input_tokens, output_tokens, total_tokens, ...}` (pydantic-ai `RequestUsage`).
- `model_name`: str.
- `finish_reason`: str (when present).

## Part taxonomy

Mirrors pydantic-ai's discriminated `Part` union. Plan Task 1 confirms exact `part_kind` discriminator values.

| `part_kind` | Where it appears | Content |
|---|---|---|
| `user_prompt` | Request | `content: str | list[str | BinaryContent | ImageUrl | DocumentUrl | AudioUrl | binary_ref]`. Multimodal lives here. |
| `system_prompt` | Request | `content: str`. Legacy; modern path uses `instructions` on the request. Kept because providers still emit it. |
| `tool_return` | Request | `tool_name`, `content`, `tool_call_id`, `timestamp`. Tool result handed back to the model. |
| `retry_prompt` | Request | `content`, `tool_name`, `tool_call_id`, `timestamp`. Fired when a tool raised `ModelRetry`. |
| `builtin_tool_return` | Request | Provider-side tool return (e.g., OpenAI `file_search`). |
| `text` | Response | `content: str`. Assistant text. |
| `tool_call` | Response | `tool_name`, `args`, `tool_call_id`. Assistant requesting a tool. |
| `thinking` | Response | `content: str`. OpenAI Responses API reasoning content. |
| `builtin_tool_call` | Response | Provider-side tool call (e.g., Anthropic `web_search`). |

`UserPromptPart.content` is the entry point for multimodal: a list mixing `str`, `BinaryContent(data, media_type)`, `ImageUrl(url)`, `DocumentUrl(url)`, `AudioUrl(url)`. Phase 1 stores them as pydantic-ai's serialized form. When content is large (binary or above threshold), phase 1's encoder defers to `binary_ref` — see `§Reference shapes`.

## Reference shapes

`.aux/<sha256>` is the content-addressed aux store. Phase 1 reserves the location and defines the reference shapes; **phase 1 does not write to `.aux/`**. First consumer (probably phase 6 tools returning binaries, or phase 3 dynamic instructions if they grow large) wires the spill-to-aux logic.

### `binary_ref`

Replaces large or binary content inline in a `user_prompt` (or any future part that accepts the same union):

```json
{
  "type": "binary_ref",
  "sha256": "abc123...",
  "media_type": "image/png",
  "size": 102400
}
```

The bytes live at `vault/transcripts/.aux/<sha256>`. Content-addressed: identical artifacts dedupe.

### `instructions_ref`

Replaces large `instructions` strings on a `model_message[kind=request]`:

```json
{
  "instructions_ref": {"sha256": "def456...", "preview": "You are a helpful..."}
}
```

The full instructions live at `vault/transcripts/.aux/<sha256>` (or `vault/transcripts/.aux/instructions/<sha256>.txt` if the implementer prefers a subdirectory). `preview` is the first ~200 chars for inspection.

## Reader policy

The reader (`reader.read_conversation(conversation_id) -> list[ModelMessage]`) tolerates these conditions without raising:

- **Truncated trailing line.** Last line of the file fails JSON parse. Logged as `truncation`; reader returns prior valid prefix. Recovery path for crash-mid-append.
- **Unknown `part_kind`.** pydantic-ai released a new part type that this format doesn't know. Logged as `unknown_part`; the part is dropped, the message survives with remaining parts.
- **Unknown `kind`** (event-kind, not part-kind). Logged; event skipped.
- **Orphan `run_start` without `run_end`.** Logged; reader treats run as `status: "interrupted"` for replay purposes. Does not synthesize a `run_end` event into the file; the next writer may.

A reader **does** raise on:

- File-level read errors (permission, missing).
- Manifest-claimed file that doesn't exist on disk — caller can trigger `rebuild_from_vault`.

## Encode / decode round-trip

The integrity guarantee phase 1 commits to: for any `messages = result.all_messages()` from a run, `decode(encode(messages)) == messages` (pydantic-equality, ignoring envelope fields). Tested against every `part_kind` and against multimodal content. The implementer adds tests for any part kind not in the original test set.

## Consumer notes

- **Phase 1 (write + read).** Recorder appends; chat handler reads to seed `message_history`. Both use the writer / reader primitives.
- **Phase 2 (read).** Chunker walks each conversation's JSONL; emits one chunk per `(run_id, role)` for embedding. `text` parts from responses + `user_prompt` parts from requests are the searchable content.
- **Phase 3 (subscribe via bus).** Memory extraction subscribes to `TurnComplete` events on the in-process bus (the bus is fed by the same recorder that writes the JSONL). The JSONL is the canonical record; the bus is the live notification path.
- **Phase 5 (replay).** Eval harness reads a conversation's JSONL, optionally trims to a prefix, and replays via `Agent.run(message_history=...)`. The encode/decode round-trip lock-in is exactly what makes this safe.
- **Phase 8 (read for pattern mining).** Skill drafter walks JSONL across conversations, extracts tool-call patterns, drafts skills.
- **Phase 10 (read).** Self-improvement loop reads JSONL for self-analysis.

## Refinement points for the implementer

When phase 1's plan implements this:

1. Confirm exact `part_kind` discriminator strings (`"user_prompt"` vs `"user-prompt"`, etc.) from `ModelRequestPart.__discriminator__` and `ModelResponsePart.__discriminator__` (or wherever pydantic-ai stores the type tags).
2. Confirm `RequestUsage` field names: `input_tokens` / `output_tokens` / `total_tokens` or a different shape.
3. Confirm `ModelMessage` serialization path. Use whichever of these round-trips cleanly: `ModelMessagesTypeAdapter` if exposed, `model_dump(mode="json")` + discriminated `model_validate`, or pydantic-ai's own to/from-JSON helpers.
4. Capture a redacted real-encoded sample of every `part_kind` exercised under test, paste under a `## Sample lines` heading in this doc.
5. Set `last-verified` to the implementation date; record the pydantic-ai version range used.
6. If pydantic-ai 1.103+ adds new part kinds (e.g., audio output, video), append rows to the part taxonomy.
