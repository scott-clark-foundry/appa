---
title: "AG-UI surface (verified)"
status: "verified against pydantic-ai 1.102.0 on 2026-05-23"
plan: ../plans/01-ag-ui-migration.md
pydantic-ai-pin: ">=1.102,<2"
last-verified: 2026-05-23
---

# AG-UI surface

This reference doc pins the AG-UI wire surface we depend on, so every plan that touches `/chat`, the smoke test, or `assistant/client.py` can cite a single source of truth.

**Status**: verified against `pydantic-ai==1.102.0` on 2026-05-23 via an inline `AGUIAdapter` probe. Re-verify at every pydantic-ai minor-version bump (see `last-verified` in frontmatter).

## Why this exists

AG-UI is a cross-vendor protocol for streaming chat events ([spec](https://docs.ag-ui.com/introduction)). pydantic-ai ships an adapter so any pydantic-ai `Agent` can speak AG-UI without hand-rolling SSE framing. The surface we depend on:

- **`pydantic_ai.ui.ag_ui.AGUIAdapter`** — server-side dispatcher; the FastAPI `/chat` route delegates to its `dispatch_request(request, agent=...)` classmethod.
- **`ag_ui.core`** — Python types for `RunAgentInput`, the `EventType` enum, and the typed event classes. Pulled in transitively by pydantic-ai (the `ag-ui` extra was not required at 1.102 — `ag_ui.core` imported cleanly under the default install; see PF2 in the plan).

Spec drift between pydantic-ai minor versions has historically touched field casing and event-name strings. Pin a floor in `pyproject.toml`; document the version here; re-verify at every minor-version bump.

## `RunAgentInput` (request body)

The body POSTed to `/chat`. All field names and required/optional flags below are verified against `RunAgentInput.model_fields.keys()` at pydantic-ai 1.102.0.

| Field | Type | Required | Notes |
|---|---|---|---|
| `thread_id` | `str` | yes | UUID-shaped; one per chat session. Snake-case on the wire (validated via inline POST). |
| `run_id` | `str` | yes | UUID-shaped; one per turn. |
| `parent_run_id` | `Optional[str]` | no (default `None`) | Threading hint; unused at scaffold time. |
| `state` | `Any` | yes | `None` is accepted for stateless turns. State management is phase 3 territory. |
| `messages` | `list[UserMessage \| AssistantMessage \| SystemMessage \| DeveloperMessage \| ToolMessage \| ActivityMessage \| ReasoningMessage]` | yes | Discriminated union on `role`. At scaffold, exactly one `UserMessage`. |
| `tools` | `list[Tool]` | yes | Empty list at scaffold (no tools registered). The empty list is REQUIRED, not optional — omitting the key fails validation. |
| `context` | `list[Context]` | yes | Empty list at scaffold. Same required-empty rule as `tools`. |
| `forwarded_props` | `Any` | yes | `None` is accepted. Reserved for cross-call payloads. |

**`UserMessage` minimum**: `id: str` (required, UUID-shaped), `content: str` (required), `role: "user"` (defaults to `"user"`, can be omitted).

**Wire casing note (verified):** request bodies accept the snake-case field names listed above (what `model_fields.keys()` returns). Response event payloads use **camelCase** (`threadId`, `runId`, `messageId`, etc.) — see the sample SSE below. The asymmetry is real: pydantic-ai's input model is snake-case-by-name, but the emitted events follow the AG-UI spec's camelCase convention.

**Minimum-viable smoke-test fixture** (verified to dispatch successfully against `AGUIAdapter` on pydantic-ai 1.102.0):

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "run_id": "00000000-0000-0000-0000-000000000002",
  "state": null,
  "messages": [
    {
      "id": "00000000-0000-0000-0000-000000000003",
      "role": "user",
      "content": "ping"
    }
  ],
  "tools": [],
  "context": [],
  "forwarded_props": null
}
```

Notes for implementers:
- `state` and `forwarded_props` both accept `null` even though they're listed as required (their type is `Any`).
- `tools` and `context` must be present as empty arrays; pydantic rejects missing keys for these.
- `parent_run_id` can be omitted entirely.

## Event types

The events `AGUIAdapter` emits over the SSE stream. Wire string values are verified against `EventType` enum values at pydantic-ai 1.102.0. **All wire strings are `SCREAMING_SNAKE_CASE`** (e.g., `TEXT_MESSAGE_CONTENT`), **not dashed**.

The events relevant to the scaffold-stage smoke test and client adapter (subset of the full enum):

| Python class (`ag_ui.core`) | Wire `type` string (verified) | Purpose |
|---|---|---|
| `RunStartedEvent` | `RUN_STARTED` | First event in a stream. Carries `threadId`, `runId`, `timestamp`. |
| `TextMessageStartEvent` | `TEXT_MESSAGE_START` | Beginning of an assistant message. Carries `messageId`, `role`, `timestamp`. |
| `TextMessageContentEvent` | `TEXT_MESSAGE_CONTENT` | Per-chunk delta. Carries `messageId`, `delta`, `timestamp`. Emitted multiple times for streaming output. |
| `TextMessageEndEvent` | `TEXT_MESSAGE_END` | Closes the message. Carries `messageId`, `timestamp`. |
| `RunFinishedEvent` | `RUN_FINISHED` | Final event; closes the stream. Carries `threadId`, `runId`, `timestamp`. |

The full enum has 33 values (thinking, tool-call, state, step, reasoning, raw/custom, run-error variants). We only assert on the five above at scaffold time. The complete list is dumpable via `[e.value for e in EventType]`.

**Smoke test assertions** target presence of `TEXT_MESSAGE_CONTENT` (as a substring of the response body — see the sample SSE format) and `RUN_FINISHED`. The client adapter filters to `TEXT_MESSAGE_CONTENT` events and yields their `delta` strings.

### SSE framing (verified)

The wire is plain SSE. **Each event is a single `data:` line** carrying a JSON object. There is NO `event:` line — the event type is embedded in the JSON payload as the `type` field. This is different from the launch-time hand-rolled wire (`event: token` / `event: done`), where the event name was an SSE field.

A consumer parses by:
1. Splitting on `\n\n` for event boundaries.
2. Stripping the `data: ` prefix from each event's single line.
3. `json.loads` the remainder.
4. Dispatching on `payload["type"]`.

## Sample SSE (redacted, captured 2026-05-23)

Probe: inline FastAPI + `AGUIAdapter.dispatch_request` wired to a `TestModel(custom_output_text="probe-response-ok")`-backed Agent. POST the minimum-viable fixture above. Captured via `httpx.AsyncClient` + `httpx.ASGITransport`. UUIDs are deterministic constants; `timestamp` and per-message `messageId` are redacted (`<ts>`, `<msg-uuid>`).

```
data: {"type":"RUN_STARTED","timestamp":<ts>,"threadId":"00000000-0000-0000-0000-000000000001","runId":"00000000-0000-0000-0000-000000000002"}

data: {"type":"TEXT_MESSAGE_START","timestamp":<ts>,"messageId":"<msg-uuid>","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","timestamp":<ts>,"messageId":"<msg-uuid>","delta":"probe-re"}

data: {"type":"TEXT_MESSAGE_CONTENT","timestamp":<ts>,"messageId":"<msg-uuid>","delta":"sponse-ok"}

data: {"type":"TEXT_MESSAGE_END","timestamp":<ts>,"messageId":"<msg-uuid>"}

data: {"type":"RUN_FINISHED","timestamp":<ts>,"threadId":"00000000-0000-0000-0000-000000000001","runId":"00000000-0000-0000-0000-000000000002"}
```

Response headers: `status: 200`, `content-type: text/event-stream; charset=utf-8`.

Observations:
- `TEXT_MESSAGE_CONTENT` fires multiple times for a single response — `TestModel` chunks `probe-response-ok` into `probe-re` + `sponse-ok`. Assembled deltas concatenate to the full string.
- The default `TestModel()` (no `custom_output_text`) produces a single `TEXT_MESSAGE_CONTENT` event with `delta == "success (no tool calls)"`. This is the distinctive marker the smoke test asserts on to prove `dependency_overrides[get_agent]` fired (per Plan 01 Task 3 contract).
- Event ordering is fixed: `RUN_STARTED` → `TEXT_MESSAGE_START` → 1..N × `TEXT_MESSAGE_CONTENT` → `TEXT_MESSAGE_END` → `RUN_FINISHED`. The client adapter does not need to handle out-of-order events.

## Pointers

- pydantic-ai docs (use context7 or [the live docs site](https://ai.pydantic.dev/)) for `AGUIAdapter` API surface.
- AG-UI spec: <https://docs.ag-ui.com/introduction>.
- AG-UI migration plan: `docs/plans/01-ag-ui-migration.md`.
