---
title: "AG-UI surface (planner seed)"
status: "seed — refine in Plan 01 Task 1 against the live import"
spec: ../specs/00-init-scaffold.md#d5-post-draft-amendment-ag-ui-as-the-canonical-wire-format
plan: ../plans/01-ag-ui-migration.md
pydantic-ai-pin: ">=1.102,<2"
last-verified: null
---

# AG-UI surface

This reference doc pins the AG-UI wire surface we depend on, so every plan that touches `/chat`, the smoke test, or `assistant/client.py` can cite a single source of truth.

**Status**: planner seed. The fields below are the planner's best-effort guess; the implementer verifies against `pydantic_ai.ui.ag_ui.AGUIAdapter` and `ag_ui.core` in Plan 01 Task 1 and amends this doc with the verified values, sets `last-verified` to the date, and commits.

## Why this exists

AG-UI is a cross-vendor protocol for streaming chat events ([spec](https://docs.ag-ui.com/introduction)). pydantic-ai ships an adapter so any pydantic-ai `Agent` can speak AG-UI without hand-rolling SSE framing. The surface we depend on:

- **`pydantic_ai.ui.ag_ui.AGUIAdapter`** — server-side dispatcher; the FastAPI `/chat` route delegates to its `dispatch_request(request, agent=...)` classmethod.
- **`ag_ui.core`** — Python types for `RunAgentInput`, the event-type enum, and the typed event classes. Pulled in transitively by pydantic-ai's `ag-ui` extra; verify importability at Task 1.

Spec drift between pydantic-ai minor versions has historically touched field casing and event-name strings. Pin a floor in `pyproject.toml`; document the version here; re-verify at every minor-version bump.

## `RunAgentInput` (request body)

The body POSTed to `/chat`. Minimum field set (verify at Task 1):

| Field | Type | Notes |
|---|---|---|
| `thread_id` | `str` | UUID-shaped; one per chat session. Field casing may be `threadId` on the wire; verify. |
| `run_id` | `str` | UUID-shaped; one per turn. |
| `messages` | `list[Message]` | At minimum one user message (`role: "user"`, `content: "..."`, `id: <uuid>`). |
| `tools` | `list[Tool]` | Empty list at phase 0 (no tools registered). |
| `state` | `dict` / `None` | Empty / `None` at phase 0 (state management is phase 3). |
| `context` | `list` / `dict` | Empty at phase 0. |

**Minimum-viable smoke-test fixture** (target shape; verify the exact field names at Task 1):

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "run_id": "00000000-0000-0000-0000-000000000002",
  "messages": [
    {
      "id": "00000000-0000-0000-0000-000000000003",
      "role": "user",
      "content": "ping"
    }
  ],
  "tools": [],
  "state": null,
  "context": []
}
```

If pydantic-ai validates additional fields as required, the implementer adds them here.

## Event types

The events `AGUIAdapter` emits over the SSE stream. Wire string casing (dashed vs camelCase) is verified at Task 1.

| Python class (`ag_ui.core`) | Wire event name (verify) | Purpose |
|---|---|---|
| `RunStartedEvent` | `run-started` | First event in a stream. |
| `TextMessageStartEvent` | `text-message-start` | Beginning of an assistant message. |
| `TextMessageContentEvent` | `text-message-content` | Per-token delta; payload includes a `delta` field. |
| `TextMessageEndEvent` | `text-message-end` | Closes the message. |
| `RunFinishedEvent` | `run-finished` | Final event; closes the stream. |

The smoke test asserts on at least `text-message-content` (presence and non-empty `delta` field) and `run-finished` (the stream closed cleanly). The client adapter filters to `text-message-content` events and yields `delta` values.

## Acceptance for this reference doc

Tied to Plan 01 Task 1:

- [ ] Verify `ag_ui.core` imports cleanly under the current `pyproject.toml`. If not, add the `[ag-ui]` extra to the `pydantic-ai` dep line and `uv sync`.
- [ ] Capture the exact `RunAgentInput` field names (case included) from `RunAgentInput.model_fields.keys()`.
- [ ] Capture the exact event-type strings from `EventType` enum values.
- [ ] Capture a redacted sample SSE byte stream from a probe POST against an inline `AGUIAdapter` app for `"ping" → ...`.
- [ ] Fill in the `last-verified` frontmatter date and the verified pydantic-ai version.
- [ ] Commit this doc; subsequent tasks cite the verified values, not the seed guesses.

## Pointers

- pydantic-ai docs (use context7 or [the live docs site](https://ai.pydantic.dev/)) for `AGUIAdapter` API surface.
- AG-UI spec: <https://docs.ag-ui.com/introduction>.
- AG-UI migration plan: `docs/plans/01-ag-ui-migration.md`.
- Phase 0 spec: `docs/specs/00-init-scaffold.md` §D5 (where the AG-UI decision is recorded).
