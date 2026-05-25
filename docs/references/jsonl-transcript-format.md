---
title: "JSONL transcript format"
status: draft
introduced: phase 1
pydantic-ai-pin: ">=1.102,<2"  # matches assistant/docs/references/ag-ui-surface.md
consumers: phase 1 (write+read), phase 2 (read for indexing), phase 3 (subscribe via bus), phase 5 (replay), phase 8 (read for pattern mining), phase 10 (read)
last-verified: 2026-05-24
---

# JSONL transcript format

The on-disk record of every pydantic-ai `Agent.run()` the assistant performs. One file per conversation (`thread_id`), append-only, one JSON object per line. Every event from a run lands here; replay of a conversation is a matter of streaming the JSONL.

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
      {"part_kind": "user-prompt", "content": "What's on my calendar tomorrow?", "timestamp": "2026-05-23T14:30:13.001Z"}
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

`status` is `"completed"` | `"cancelled"` | `"errored"`. Cancellation produces a `run_end` with `status: "cancelled"`; the `model_message` events that landed before the cancel are present in the file (per-message append granularity guarantees no in-flight loss).

## Envelope schema (every line)

| Field | Type | Notes |
|---|---|---|
| `uuid` | str | Event identifier in our store. ULID-shaped recommended (sortable). Not the pydantic-ai run_id. |
| `parent_uuid` | str \| null | Previous event in causal chain. `null` only on `conversation_start`. |
| `kind` | `"conversation_start"` \| `"run_start"` \| `"model_message"` \| `"run_end"` | Discriminator. |
| `timestamp` | str (ISO 8601, UTC, microsecond) | When the event was recorded. |
| `conversation_id` | str | pydantic-ai's conversation_id; equals AG-UI thread_id. |
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

Serialized `ModelRequest` or `ModelResponse` from pydantic-ai. Use `pydantic_ai.messages.ModelMessagesTypeAdapter` (verified present at 1.102.0); `validate_python` / `validate_json` round-trip the list form. Single-message decoding can fall back to `ModelRequest.model_validate` / `ModelResponse.model_validate` discriminated on `payload["kind"]` (`"request"` | `"response"`).

### Common fields

- `kind`: `"request"` | `"response"`.
- `parts`: list of part objects; see `§Part taxonomy`.

### Request-only fields

- `instructions`: str. The (potentially dynamic) instructions for this request. May swap to `instructions_ref` when large.

### Response-only fields

- `usage`: pydantic-ai `RequestUsage` (a dataclass, not a pydantic model). Verified fields: `input_tokens`, `output_tokens`, `cache_write_tokens`, `cache_read_tokens`, `input_audio_tokens`, `output_audio_tokens`, `cache_audio_read_tokens`, `details`. `total_tokens` is a computed property (not serialized as a field). The serialized JSON shape carries all eight named fields with integer defaults of `0` and `details: {}`.
- `model_name`: str.
- `provider_name`: str (provider identifier; e.g. `"openai"`, `"test"`).
- `finish_reason`: str (when present).

## Part taxonomy

Mirrors pydantic-ai's discriminated `Part` union. Discriminator string values verified against `dataclasses.fields(cls)` defaults at pydantic-ai 1.102.0 (2026-05-24).

**All `part_kind` values are kebab-case** (not snake_case). The wire format of the AG-UI response events is the same convention (`TEXT_MESSAGE_CONTENT` payloads use kebab discriminators inside `parts`).

| `part_kind` | Where it appears | Class | Content |
|---|---|---|---|
| `user-prompt` | Request | `UserPromptPart` | `content: str | list[str | BinaryContent | ImageUrl | DocumentUrl | AudioUrl | binary_ref]`. Multimodal lives here. |
| `system-prompt` | Request | `SystemPromptPart` | `content: str`. Legacy; modern path uses `instructions` on the request. Kept because providers still emit it. |
| `tool-return` | Request | `ToolReturnPart` | `tool_name`, `content`, `tool_call_id`, `timestamp`. Tool result handed back to the model. |
| `retry-prompt` | Request | `RetryPromptPart` | `content`, `tool_name`, `tool_call_id`, `timestamp`. Fired when a tool raised `ModelRetry`. |
| `builtin-tool-return` | Request | `NativeToolReturnPart` (aka `BuiltinToolReturnPart`, deprecated alias) | Provider-side tool return (e.g., OpenAI `file_search`). |
| `text` | Response | `TextPart` | `content: str`. Assistant text. |
| `tool-call` | Response | `ToolCallPart` | `tool_name`, `args`, `tool_call_id`. Assistant requesting a tool. |
| `thinking` | Response | `ThinkingPart` | `content: str`. OpenAI Responses API reasoning content. |
| `builtin-tool-call` | Response | `NativeToolCallPart` (aka `BuiltinToolCallPart`, deprecated alias) | Provider-side tool call (e.g., Anthropic `web_search`). |

Additional part classes discovered in pydantic-ai 1.102.0 (`FilePart` → `file`, `InstructionPart` → `instruction`, `CompactionPart` → `compaction`, search-variant `ToolSearchCallPart` / `ToolSearchReturnPart` reuse the `tool-call` / `tool-return` discriminators). The reader treats any unrecognised `part_kind` per `§Reader policy` (logged as `unknown_part`, dropped, message survives).

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

## AG-UI capture path

**Chosen path: Branch A via `on_complete` callback on `AGUIAdapter.run_stream(...)`.** Verified 2026-05-24 against pydantic-ai 1.102.0.

The `AGUIAdapter` instance does *not* expose the run's assistant messages as a post-stream attribute. `adapter.messages` is the input history reconstructed from `run_input.messages` and is not updated by `run_stream()`. However, `run_stream()` accepts an `on_complete` kwarg whose type alias `pydantic_ai.ui.OnCompleteFunc` is:

```python
Callable[[AgentRunResult[Any]], None]
  | Callable[[AgentRunResult[Any]], Awaitable[None]]
  | Callable[[AgentRunResult[Any]], AsyncIterator[EventT]]
```

The callback receives an `AgentRunResult` after the agent run completes (before the encoded stream finishes draining to the client). From the result we get:

- `result.all_messages()` — the full conversation list (`list[ModelMessage]`) including the user request reconstructed from `run_input` and the assistant `ModelResponse` with `usage`, `model_name`, `provider_name`, timestamps, and `run_id` / `conversation_id` all populated.
- `result.new_messages()` — just the messages added by this run (the recorder uses this so the JSONL never double-records prior history).
- `result.output`, `result.usage`, `result.run_id`, `result.conversation_id`, `result.metadata`, `result.timestamp`.

The recorder's `append_messages(messages=result.new_messages(), ...)` is the single call that captures everything pydantic-ai knows about the run — usage stats, tool calls, thinking parts, multimodal content — without degradation.

**Rejected path: Branch B (tap encoded SSE).** The encoded events from `encode_stream(...)` are AG-UI text deltas + lifecycle events. Reassembling a `ModelResponse` from them would lose usage, tool-call structure, thinking parts, and provider metadata. Branch A via `on_complete` is fully intact, so Branch B is unnecessary.

**Cancellation note.** `on_complete` only fires on clean completion. The `/chat` handler wraps the drain in a `try/finally`; on `asyncio.CancelledError` the finally branch appends any partial state that landed (Branch-A-style intact capture is unavailable here — the run didn't complete), the user's `ModelRequest` (so the user turn is preserved), and a `run_end` with `status: "cancelled"`. Phase 1's cancellation path therefore *does* synthesize a degraded `ModelResponse` from whatever the AGUIAdapter accumulated; the next plan that gets called on this surface should re-verify whether pydantic-ai has added a clean hook for the cancelled path.

## Server-canonical history (how it's threaded)

`AGUIAdapter.run_stream(...)` accepts both `conversation_id: str | None` and `message_history: Sequence[ModelMessage] | None` as kwargs (verified 2026-05-24). The handler reads JSONL via `reader.read_conversation(...)`, passes the reconstructed list as `message_history=...`, and passes the thread_id as `conversation_id=...`. Per pydantic-ai's `message_history` contract (see Input and History reference in the building-pydantic-ai-agents skill): when `message_history` is non-empty, pydantic-ai assumes it already carries the system prompt, so the recorder never has to re-emit instructions in subsequent turns of the same conversation.

The `/chat/sync` handler uses the same kwargs on `Agent.run(...)` directly. Both wires use the identical recorder API; only the capture hook differs.

## Encode / decode round-trip

The integrity guarantee phase 1 commits to: for any `messages = result.all_messages()` from a run, `decode(encode(messages)) == messages` (pydantic-equality, ignoring envelope fields). Tested against every `part_kind` and against multimodal content. The implementer adds tests for any part kind not in the original test set.

## Consumer notes

- **Phase 1 (write + read).** Recorder appends; chat handler reads to seed `message_history`. Both use the writer / reader primitives.
- **Phase 2 (read).** Chunker walks each conversation's JSONL; emits one chunk per `(run_id, role)` for embedding. `text` parts from responses + `user-prompt` parts from requests are the searchable content.
- **Phase 3 (subscribe via bus).** Memory extraction subscribes to `TurnComplete` events on the in-process bus (the bus is fed by the same recorder that writes the JSONL). The JSONL is the canonical record; the bus is the live notification path.
- **Phase 5 (replay).** Eval harness reads a conversation's JSONL, optionally trims to a prefix, and replays via `Agent.run(message_history=...)`. The encode/decode round-trip lock-in is exactly what makes this safe.
- **Phase 8 (read for pattern mining).** Skill drafter walks JSONL across conversations, extracts tool-call patterns, drafts skills.
- **Phase 10 (read).** Self-improvement loop reads JSONL for self-analysis.

## Sample lines

Captured 2026-05-24 against pydantic-ai 1.102.0 via the Task 1 probe script. Each sample is the JSON-serialized `payload` field (the `model_message` envelope wraps it). `timestamp` and `run_id` values are redacted as `<ts>` / `<run-id>` for readability; the live wire carries ISO-8601 UTC microsecond strings and ULID-shaped uuids in the envelope.

**Request: `user-prompt`** (round-tripped via `ModelMessagesTypeAdapter`):

```json
{
  "kind": "request",
  "parts": [
    {"part_kind": "user-prompt", "content": "hello", "timestamp": "<ts>"}
  ],
  "instructions": null,
  "timestamp": null,
  "run_id": null,
  "conversation_id": null,
  "metadata": null
}
```

**Response: `text`** (round-tripped):

```json
{
  "kind": "response",
  "parts": [
    {"part_kind": "text", "content": "world", "id": null, "provider_name": null, "provider_details": null}
  ],
  "usage": {
    "input_tokens": 0, "output_tokens": 0, "cache_write_tokens": 0, "cache_read_tokens": 0,
    "input_audio_tokens": 0, "output_audio_tokens": 0, "cache_audio_read_tokens": 0,
    "details": {}
  },
  "model_name": null,
  "provider_name": null,
  "provider_url": null,
  "provider_details": null,
  "provider_response_id": null,
  "finish_reason": null,
  "timestamp": "<ts>",
  "run_id": null,
  "conversation_id": null,
  "metadata": null,
  "state": "complete"
}
```

**Request: `system-prompt`** (shape — not exercised live by probe; based on `SystemPromptPart` dataclass):

```json
{
  "kind": "request",
  "parts": [
    {"part_kind": "system-prompt", "content": "You are a helpful assistant.", "dynamic_ref": null, "timestamp": "<ts>"}
  ]
}
```

**Request: `tool-return`** (shape — not exercised live; from `ToolReturnPart`):

```json
{
  "kind": "request",
  "parts": [
    {"part_kind": "tool-return", "tool_name": "get_weather", "content": "sunny", "tool_call_id": "call_123", "timestamp": "<ts>"}
  ]
}
```

**Request: `retry-prompt`** (shape — not exercised live; from `RetryPromptPart`):

```json
{
  "kind": "request",
  "parts": [
    {"part_kind": "retry-prompt", "content": "Tool 'x' raised ModelRetry", "tool_name": "x", "tool_call_id": "call_456", "timestamp": "<ts>"}
  ]
}
```

**Response: `tool-call`** (shape — not exercised live; from `ToolCallPart`):

```json
{
  "kind": "response",
  "parts": [
    {"part_kind": "tool-call", "tool_name": "get_weather", "args": {"city": "SF"}, "tool_call_id": "call_789"}
  ],
  "usage": {"input_tokens": 0, "output_tokens": 0, "...": "..."},
  "model_name": "gpt-5-nano"
}
```

**Response: `thinking`** (shape — not exercised live; from `ThinkingPart`):

```json
{
  "kind": "response",
  "parts": [
    {"part_kind": "thinking", "content": "Let me work through this..."}
  ]
}
```

**Request: `builtin-tool-return` / Response: `builtin-tool-call`** (shape — not exercised live; from `NativeToolReturnPart` / `NativeToolCallPart`, formerly `BuiltinToolReturnPart` / `BuiltinToolCallPart` which are now deprecated aliases at 1.102.0):

```json
{
  "kind": "response",
  "parts": [
    {"part_kind": "builtin-tool-call", "tool_name": "web_search", "args": {"query": "..."}, "tool_call_id": "btu_001"}
  ]
}
```

The encoder produces these shapes via `event.model_dump_json(exclude_none=True)`; sidechain-only envelope fields and explicit-null payload fields drop out. The round-trip tests (Task 7) walk each `part_kind` and prove pydantic-equality post-decode.
