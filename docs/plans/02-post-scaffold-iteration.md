---
title: "Post-scaffold iteration: config DI, teaching comments, /chat/sync"
summary: "Retrospective for work landed between the AG-UI migration and the start of phase 1. Three small iterations the original plans didn't anticipate, plus a documentation/test cleanup pass."
status: complete
author: Scott Clark
phase: "0 of 10 (extensions)"
spec: n/a (retrospective; no upfront spec)
progression: "progression #l0"
branch: main (each iteration shipped via its own PR)
started: 2026-05-23
tags: [phase-0, retrospective, config, comments, chat-sync]
---

# Post-scaffold iteration: config DI, teaching comments, `/chat/sync`

_Retrospective for work that landed between PR #1 (AG-UI migration) and the start of phase 1 (transcripts). Three iterations the original phase-0 and AG-UI plans didn't anticipate, plus a documentation/test cleanup pass on top._

## 01. Intent

The two formal plans (`00-init-scaffold.md`, `01-ag-ui-migration.md`) cover the scaffold and the wire-format shift. Real use surfaced three follow-ups that didn't warrant individual plan docs upfront — each small enough to be planned in-conversation, each large enough to merit a paper trail. This doc captures them so the project history is legible without spelunking git log.

What this doc is *not*: a plan to execute. The work has shipped. This is a retrospective ledger.

## 02. Iterations

### Iteration A — Config DI fix (PR #2, commit `09418f0`)

**Trigger:** The AG-UI live probe surfaced that `OPENAI_API_KEY` in `.env` wasn't reaching the OpenAI provider on a fresh `uv run uvicorn assistant.app:app`. pydantic-settings populated `Settings.OPENAI_API_KEY`, but pydantic-ai's provider reads from `os.environ` — and pydantic-settings does **not** sync the two. The bug only surfaced when running outside the test suite (`TestModel` substitution bypasses real model construction entirely).

**Resolution:** Push model construction down to where Settings already has the typed value. New `Settings.build_model()` method dispatches on `MODEL_PROVIDER` (now a `Literal["openai", "anthropic", "openrouter"]` instead of the old `"openai:gpt-5-nano"` string shorthand) and threads `api_key=...` into the provider explicitly. `build_agent` collapses to a one-liner around `Settings.build_model()`.

**Decision recorded:** We deliberately did NOT mutate `os.environ`. That would have been a workaround for code that shouldn't be reading from process env in the first place. pydantic-settings is canonically a *reader*, not a sync layer. This is the "Settings as DI boundary" pattern — see `NOTES.md` for the long-form treatment.

**Bonus:** Anthropic and OpenRouter became selectable by config alone (set `MODEL_PROVIDER` plus the matching API key). Adding a vendor is now a localized diff: one branch in `build_model` plus one `<PROVIDER>_API_KEY` field.

**Files touched:** `assistant/config.py`, `assistant/agent.py`, `tests/test_config.py` (count grew from 13 to 20), `.env`, `.env.example`, `CHANGELOG.md`, `NOTES.md`.

### Iteration B — Strategic teaching comments + NOTES section (PR #3, commit `91aa97a`)

**Trigger:** Preparing the codebase for a conversational walkthrough. Each source file in `assistant/` was missing the *why* — the architectural choices and seam-points a reader needs to navigate the structure.

**Resolution:** Added a module docstring plus 2–4 inline strategic comments to every file in `assistant/`. Added the `## Config: Settings as the DI boundary` section to `NOTES.md` as the canonical written companion to Iteration A.

**Note on comment style (refined later in Iteration C):** The first pass leaned on historical narrative ("we did X rather than Y") and reproduced test-override code in docstrings. This was tightened in Iteration C — see *Comment style refactor* below.

**Files touched:** Every file in `assistant/`, plus `NOTES.md`.

### Iteration C — `/chat/sync` endpoint + comment refactor + mypy cleanup (this session)

#### `/chat/sync` endpoint

**Trigger:** Mid-walkthrough, an honest look at `assistant/client.py` showed it forcing Python callers to construct a `RunAgentInput` and parse SSE just to retrieve a final string. The streaming wire (`/chat` / AG-UI) is valuable when you want token deltas; it's friction when you just want the result.

**Resolution:** Added `POST /chat/sync`. Body `{"message": str}`, response `{"output": str}`. Internally `await agent.run(body.message)`. The streaming `/chat` is unchanged.

**Trade-off accepted on purpose:** Two wires (AG-UI for streamers, plain JSON for result-only callers) instead of one. The original AG-UI plan staked out "AG-UI is THE wire"; this iteration partially walks that back, deliberately, because forcing one shape to serve both use cases was where the friction lived. Most agent platforms ship both.

**`AssistantClient` narrows:** From "the Python way to call the API" to "the Python way to *stream*." For result-only callers, the right client is `httpx.post(url, json={...}).json()["output"]` — no wrapper needed.

#### Comment style refactor

**Trigger:** User feedback during the walkthrough — *"refactor your comments a bit to make them contain less historical decisions and more why an approach is better, try not to reproduce code inside comments so much."*

**Resolution:** Rewrote `assistant/app.py` docstrings and inline comments. Dropped reproduced test-override lambdas. Replaced "we did X rather than Y" framing with property-of-the-chosen-design statements. ~⅓ less comment volume, same architectural ideas.

Also fixed a directionality muddle in `assistant/client.py`: the old framing called this file *"outgoing AG-UI"* and `app.py` *"incoming AG-UI,"* which inverted the natural producer/consumer reading (the `/chat` endpoint **produces** AG-UI events; the Python adapter **consumes** them). New framing: explicit producer/consumer language throughout.

**Memory:** A feedback memory was written for the protocol-direction issue specifically — see `feedback_protocol_direction_framing.md` in user memory.

#### mypy cleanup

**Trigger:** 13 `Unexpected keyword argument "_env_file"` errors across 5 test files when running `uv run mypy assistant tests`. Root cause: pydantic-settings' `_env_file=None` magic kwarg isn't declared on `BaseSettings.__init__`, so mypy can't see it.

**Resolution:** New `tests/_helpers.py::make_test_settings(**overrides: Any)` centralises the `_env_file=None` kwarg and its `# type: ignore[call-arg]` in one place. All 13 call sites updated. Two pre-existing wrong `# type: ignore[arg-type]` comments in `tests/test_config.py` removed — `**overrides: Any` accepts the Literal-violating values cleanly.

#### Documentation sync

`README.md` first-chat section now leads with `/chat/sync` (the simple path) and presents `AssistantClient.stream_chat` as the streaming option. `NOTES.md` gained the `## /chat/sync: a second wire for non-streaming callers` section. `CHANGELOG.md` `[0.0.3]` entry covers all of Iteration C.

**Files touched:** `assistant/app.py`, `assistant/client.py`, `tests/test_smoke.py`, `tests/test_agent.py`, `tests/test_client.py`, `tests/test_config.py`, `tests/test_logging_setup.py`, `tests/_helpers.py` (new), `README.md`, `NOTES.md`, `CHANGELOG.md`.

## 03. State at close

Phase 0 acceptance criteria (from `00-init-scaffold.md` §08) — every box is ticked. AG-UI migration acceptance criteria (from `01-ag-ui-migration.md` §08) — every box is ticked. Ruff + mypy + pytest all clean (22 tests pass). README/NOTES/CHANGELOG reflect the current state.

## 04. What didn't happen (and why)

- **No parallel `AssistantClient.stream_sync(message) -> str` method.** The whole point of `/chat/sync` was that a wrapper isn't needed — `httpx.post(...).json()["output"]` is the whole client. Adding the wrapper would defeat its own purpose.
- **No background-task / poll-result pattern for `/chat/sync`.** Considered during the design conversation. Rejected: it would require persistent run storage (in-memory dict / SQLite / Redis), drain-the-stream-into-storage server logic regardless of client reads, and lifecycle questions (when to evict completed runs?). For "just give me the final string," the synchronous `await agent.run(...)` is the right shape — runs in the request handler, no extra state.
- **No removal of `assistant/client.py`.** Considered as part of `/chat/sync` framing. Decided to keep it: it's now the streaming-only Python entry point, the maintenance cost is essentially zero, and the streaming use case is real (CLI tools, future agent loops).

## 05. Pointers

- Plans: `docs/plans/00-init-scaffold.md`, `docs/plans/01-ag-ui-migration.md`.
- CHANGELOG: every iteration here has a corresponding versioned entry — `[0.0.1]` (AG-UI), `[0.0.2]` (Config DI), `[0.0.3]` (this session).
- NOTES: the conceptual companion to each iteration's plan/retrospective. See `## AG-UI migration, no phase 1`, `## Config: Settings as the DI boundary`, `## /chat/sync: a second wire for non-streaming callers`.
- TBC notes: `docs/tbc/` holds session-resume notes; useful for understanding *why* a given iteration was triggered (each one ties back to an in-flight conversation).
