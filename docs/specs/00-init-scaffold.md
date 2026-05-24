---
phase: 0
progression-plan: ../plans/python-llm-app-progression.md#l0
status: draft
slug: init-scaffold
branch: init/scaffold
---

# Phase 0 spec: `init/scaffold`

## Intent

Land the `assistant/` repo on its first green CI build with a working SSE chat endpoint, no persistence, no tools. Phase 0 is the foundation every later phase builds on; getting the wiring right matters more than getting any individual feature right.

The progression plan describes phase 0 in §08 (Init) and §13.1 (init DOD checklist). This spec captures the additional decisions made during phase-0 brainstorming and the module-level structure that those decisions imply.

## What's locked by the progression plan

These are not re-decided here; they are inherited from the progression plan and noted so the plan author has them in one place.

- Pydantic-ai `Agent` with zero tools registered (§08, ADR-001).
- FastAPI backend with one Server-Sent Events chat endpoint (§08, ADR-002).
- Conversation in-memory only; durable persistence arrives in phase 1 (§08).
- Tracing via pydantic-ai's Logfire instrumentation, enabled at init (§I5).
- structlog configured for application logging (§08).
- Provider/model via a single config string, default `openai:gpt-4o-mini` (§I9, ADR-001).
- Vault paths created (`memory/`, `skills/`, `evals/`, `transcripts/`) but unused (§08).
- ruff + mypy + CI; one smoke test (chat round-trip); one eval fixture format (§08, §13.1).
- ADRs to bake in at init: ADR-001 (pydantic-ai for the model layer), ADR-002 (FastAPI), ADR-003 (one growing assistant), ADR-005 (one repo, dev cycle).

## Decisions made during phase-0 brainstorming

### D1: Flat package layout, `assistant/` repo with `assistant/` package inside

```
assistant/                  ← repo root
├── pyproject.toml
├── assistant/              ← Python package
│   ├── __init__.py
│   ├── app.py              ← FastAPI app + /chat route
│   ├── agent.py            ← pydantic-ai Agent factory
│   ├── config.py           ← pydantic-settings
│   └── logging_setup.py    ← structlog + optional Logfire wiring
├── tests/
│   └── test_smoke.py
├── vault/
│   ├── memory/.gitkeep
│   ├── skills/.gitkeep
│   ├── evals/.gitkeep
│   └── transcripts/.gitkeep
├── .env.example
├── .gitignore
├── .github/workflows/ci.yml
├── LICENSE                 ← MIT
├── README.md
├── CHANGELOG.md
└── NOTES.md
```

Rejected: `src/` layout (industry standard but unneeded since we are not publishing to PyPI), single-file `app.py` (would force a restructure in phase 1).

### D2: Vault in-repo, contents gitignored

Directory shape is committed via `.gitkeep` files so a fresh clone has the right layout. Generated content (transcripts, memory files, skill drafts, eval fixtures the user adds) is gitignored. The `.gitignore` pattern:

```
vault/**
!vault/
!vault/*/
!vault/*/.gitkeep
```

Rejected: external `VAULT_PATH` config (more flexible but adds a knob phase 0 doesn't need), fully-tracked vault (vault content is personal; the repo is public).

### D3: Smoke test uses pydantic-ai `TestModel`, no network

`tests/test_smoke.py` spins up the FastAPI app via `httpx.AsyncClient`, overrides the Agent dependency to use `pydantic_ai.models.test.TestModel`, posts a single message to `/chat`, parses the SSE response, and asserts a non-empty assistant reply. No OpenAI calls, deterministic, free.

Rejected: real LLM call in CI (slow, costly, introduces a real-world failure surface phase 0 cannot mitigate), both-with-marker (too much ceremony at init).

### D4: Conventions baked in without dedicated discussion

- **Python version:** pin to 3.13 in `pyproject.toml`. uv-managed; `uv.lock` committed.
- **Linting / typing:** ruff for lint and format, mypy in strict mode. CI fails on either.
- **CI surface:** one GitHub Actions workflow (`.github/workflows/ci.yml`) that runs on push and PR: `uv sync` → `ruff check` → `ruff format --check` → `mypy` → `pytest`. Matrix is single (3.13, ubuntu-latest); no need for a build matrix at init.
- **Eval fixture format:** markdown with YAML frontmatter, matching §13.1's "vault/evals/{phase}/" convention. At init we define the format with a single example fixture (a no-op placeholder loadable by a `load_fixture()` helper). Phase 1 starts populating it.
- **README scope:** minimal per §13.1 — one-paragraph vision, install (`uv sync` + `cp .env.example .env`), first-chat instructions (`uv run uvicorn assistant.app:app`), pointer to `NOTES.md` for the concept.
- **`/chat` shape:** `POST /chat` with JSON body `{"message": "..."}`, returns `text/event-stream`. Each `event: token` carries one delta; final `event: done` with empty data. Session-less at init; phase 1 introduces session identity. Amended in D5: this hand-rolled SSE shape is transitional and is replaced by AG-UI in the migration plan (`docs/plans/01-ag-ui-migration.md`) before phase 1 begins.
- **No pre-commit hooks** at init. CI is the gate.
- **Branch:** `init/scaffold`. Squash-merge to `main` once DOD passes locally and CI is green.

### D5 (post-draft amendment): AG-UI as the canonical wire format

The init plan (`docs/plans/00-init-scaffold.md`) shipped `/chat` with a hand-rolled SSE shape (per D4: `event: token` / `event: done`, payload `{"delta": "..."}`). After that plan was code-complete on `init/scaffold`, the [AG-UI](https://docs.ag-ui.com/introduction) protocol surfaced as the cross-vendor standard for streaming chat events, and pydantic-ai ships a built-in adapter for it (`pydantic_ai.ui.ag_ui.AGUIAdapter`). Decision: AG-UI is the canonical wire format. The hand-rolled SSE shape is transitional; a follow-on plan (`docs/plans/01-ag-ui-migration.md`) migrates `/chat` to AG-UI.

Both plans are scaffolding-level work and sit within phase 0 of the progression. Phase 1 (transcripts and the introduction of the vault-write primitives) is unchanged; the AG-UI migration does not displace it.

**Migration path.** `docs/plans/01-ag-ui-migration.md` branches off the merged init commit on `main`, delegates `/chat` to `AGUIAdapter.dispatch_request`, ships an in-package Python client adapter (`assistant/client.py`) so callers that don't want to construct `RunAgentInput` by hand stay one-liners, and updates the smoke test to assert AG-UI event shapes. The migration is structural, not a capability merge.

**Why a separate plan rather than amending the init plan in place:**

- The init plan is already code-complete and is its own reviewable unit. Re-opening it to swap the wire format commingles scaffolding with a discrete migration that earns its own NOTES.md section ("wire-protocol adapter as a seam").
- The init merges first; the AG-UI plan branches off a real `main` commit, not a tag on an unmerged branch. The rollback story is "git revert the AG-UI merge," not "navigate orphan tag history."

**Python-ergonomics regression mitigation.** AG-UI's `RunAgentInput` is verbose; one-liner curl is no longer possible. The AG-UI plan ships `assistant/client.py` to hide the request construction and yield text deltas. The seam shifts from "FastAPI route formats SSE" to "FastAPI route delegates wire format; in-Python adapter restores the one-liner."

**Rejected alternatives:**

- **Amend the init plan in place** (replace hand-rolled SSE before the init merges): commingles scaffolding with migration; loses the AG-UI concept as a distinct NOTES section.
- **Dual-endpoint setup** (`/chat` hand-rolled, `/ag-ui` AGUIAdapter): splits consumers, doubles the test surface, accretes responsibility on the simple endpoint.
- **Body-shape detection** (one endpoint accepts either body): adds branching to the route handler; saves nothing in test surface.
- **Defer AG-UI indefinitely**: locks the project into hand-rolled SSE; foregoes pydantic-ai's adapter; bad bet on the protocol.

**Reference docs.** `docs/references/ag-ui-surface.md` pins the `RunAgentInput` shape and event-name vocabulary. Planner seeds; implementer verifies in Plan 01 Task 1 against the live import.

**This spec's contracts describe the target state.** Module-level descriptions of `assistant/app.py`, `assistant/client.py`, `tests/test_smoke.py`, and `tests/test_client.py` reflect the post-migration shape. The init plan describes what was scaffolded (hand-rolled SSE); the AG-UI plan describes the migration to the target. Both ship before phase 1 (transcripts) begins.

## Module-level behavior contracts

### `assistant/agent.py`

Exposes a single factory:

```python
def build_agent(settings: Settings) -> Agent[None, str]:
    ...
```

The Agent is constructed with `model=settings.MODEL`, no tools, no result type (returns the raw string response). pydantic-ai's built-in validation retry handles §I1's "more than one call per turn" requirement implicitly.

Dependency injection seam: tests override `build_agent` to inject a `TestModel`-backed Agent. Concept: this is a test seam (a place where production code lets you substitute a dependency). Putting the factory behind a function lets `tests/test_smoke.py` swap the model without touching app code.

### `assistant/app.py`

Builds the FastAPI app, registers one route:

```python
@app.post("/chat")
async def chat(
    request: Request,
    agent: Agent[None, str] = Depends(get_agent),
) -> Response:
    ...
```

The route delegates wire-format handling to `AGUIAdapter.dispatch_request(request, agent=agent)`. The `Depends(get_agent)` seam is preserved so tests can substitute a TestModel-backed Agent via `app.dependency_overrides`. See `docs/references/ag-ui-surface.md` for the request/event shape pinned to the current pydantic-ai version. (Original brainstorming had a hand-rolled SSE generator with a `ChatRequest` BaseModel; amended in D5.)

### `assistant/client.py`

In-package async adapter for callers that don't want to construct AG-UI requests by hand. Public surface:

```python
class AssistantClient:
    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        httpx_client: httpx.AsyncClient | None = None,
    ) -> None: ...

    async def stream_chat(self, message: str) -> AsyncIterator[str]: ...
```

`stream_chat` constructs a minimal `RunAgentInput` (one user message, generated thread/run/message IDs), POSTs to `/chat` with `Accept: text/event-stream`, parses the AG-UI event stream, and yields `delta` strings from text-content events. Two test seams:

1. **Server-side**: `Depends(get_agent)` (preserved from D3).
2. **Client-side**: the optional `httpx_client` parameter; tests pass an `httpx.AsyncClient(transport=httpx.ASGITransport(app=test_app))` so the adapter hits an in-memory FastAPI instance without spawning uvicorn.

### `assistant/config.py`

A single `Settings(BaseSettings)` class reading `.env`:

```python
class Settings(BaseSettings):
    MODEL: str = "openai:gpt-4o-mini"
    OPENAI_API_KEY: str | None = None
    LOGFIRE_TOKEN: str | None = None
    VAULT_PATH: Path = Path("./vault")
    LOG_LEVEL: str = "INFO"
```

`get_settings()` returns a cached instance.

### `assistant/logging_setup.py`

Two responsibilities, kept distinct:

1. Configure structlog at startup (`LOG_LEVEL` driven).
2. If `LOGFIRE_TOKEN` is set, call `logfire.configure(token=...)` and `logfire.instrument_pydantic_ai()`. If absent, both calls are skipped and Logfire is silently disabled. This lets CI run without a Logfire account and lets local dev run with one.

### `tests/test_smoke.py`

Two tests. Same fixture pattern (`build_app` + `dependency_overrides[get_agent]` → TestModel-backed Agent). Request body is a minimal `RunAgentInput` per `docs/references/ag-ui-surface.md`.

- `test_chat_returns_ag_ui_stream`: POST a minimal `RunAgentInput`; assert 200, `content-type` starts with `text/event-stream`, the response text contains the AG-UI text-content event name and the run-finished event name (exact strings from the reference doc).
- `test_chat_assembled_text_is_non_empty`: parse the SSE stream, filter for text-content events, concatenate the `delta` field, assert non-empty.

(Amended in D5: original spec had `test_chat_round_trip` asserting on `event: token` / `event: done` shape.)

### `tests/test_client.py`

Two tests exercising `AssistantClient` against the in-memory FastAPI app (same `httpx.ASGITransport` pattern as `test_smoke.py`).

- `test_stream_chat_yields_text_deltas`: construct the client with the ASGI transport, iterate `stream_chat("ping")`, assemble deltas, assert non-empty.
- `test_stream_chat_filters_non_text_events`: assert non-text events (`run-started`, `run-finished`) do not appear in the yielded stream — yielded items are pure text deltas.

## Eval fixture format (defined here, populated by phase 1)

`vault/evals/{phase}/*.md`. Each fixture is a markdown file with YAML frontmatter:

```markdown
---
id: smoke-001
phase: 0
intent: scaffold sanity check
bucket: smoke
---

# Input

ping

# Expected

assistant reply is non-empty
```

Phase 0 ships one fixture: a placeholder demonstrating the format. The `load_fixture(path)` helper lives in `assistant/` and parses both halves. No fixture runner yet; that arrives in phase 5.

## Definition of done

Lifted from §13.1, with phase-0-specific clarifications:

- [ ] Public GitHub repo `assistant/`, MIT-licensed.
- [ ] `README.md` with vision + install + first-chat instructions.
- [ ] `pyproject.toml` with locked deps via uv; `uv.lock` committed; Python 3.13 pinned.
- [ ] `ruff check` and `mypy` clean.
- [ ] CI smoke test green on push (TestModel-backed).
- [ ] `.env.example` committed; `.env` gitignored.
- [ ] FastAPI backend with OpenAPI spec at `/docs`.
- [ ] All Agent calls route through pydantic-ai's `Agent` / `Model` interface; no provider-SDK imports in app code (`grep -R "import openai" assistant/` is empty).
- [ ] LLM calls traced via Logfire when `LOGFIRE_TOKEN` is set; no-op when absent.
- [ ] `CHANGELOG.md` and `NOTES.md` present with one entry each for the init commit.
- [ ] `vault/{memory,skills,evals,transcripts}/.gitkeep` committed; vault content gitignored.
- [ ] One eval fixture loadable via `load_fixture()` (no runner yet).
- [ ] `/chat` accepts an AG-UI `RunAgentInput` and emits AG-UI events; the route delegates to `AGUIAdapter.dispatch_request` and preserves `Depends(get_agent)`.
- [ ] `assistant/client.py` exposes `AssistantClient.stream_chat(message) -> AsyncIterator[str]`; tested against the in-memory app via `httpx.ASGITransport`.
- [ ] `docs/references/ag-ui-surface.md` documents the pinned `RunAgentInput` shape and event-name vocabulary; refined by the implementer against the live import.

## Non-goals (phase 0)

Explicit so the plan doesn't drift:

- Persistence of any kind. No SQLite, no transcripts written, no session memory. Phase 1.
- Authentication, rate limiting, deployment. Not needed for local dev; out of scope for the portfolio's "good enough for a public repo" standard (§NG4).
- Frontend beyond the FastAPI OpenAPI page. A CLI client is welcome but not required at init.
- Evals beyond format and loader. The runner and judge live in phase 5.
- Tools, retrieval, memory loading. All later phases.

## Risks specific to phase 0

| Risk | Mitigation |
|---|---|
| Logfire token wiring is brittle (token format change, network failure at startup) | Token presence is a runtime config check, not a static import. Startup never fails on Logfire issues; it logs and continues. |
| pydantic-ai's `TestModel` API drifts between releases | Pin pydantic-ai to a known-working version in `pyproject.toml`. Upgrade is a deliberate phase-1 (or later) task. |
| SSE response shape mismatch with a downstream client | AG-UI is the cross-vendor spec; pydantic-ai owns spec compliance via `AGUIAdapter`. Our wire is whatever the adapter emits. Phase 1+ CLI uses `assistant.client.AssistantClient`, so it consumes AG-UI events through a tested adapter rather than negotiating an ad-hoc shape. |
| `RunAgentInput` schema or event-name vocabulary changes between pydantic-ai minor versions; smoke-test fixture and client adapter both break | Pin pydantic-ai floor at the version verified in Task 1 of the plan; document the version in `docs/references/ag-ui-surface.md`; re-verify at every minor-version bump. |
| Test seam (`dependency_overrides[get_agent]`) doesn't behave as expected with `AGUIAdapter.dispatch_request` (adapter constructs its own Agent or grabs one from a different scope) | The AG-UI smoke test is the canary: with `dependency_overrides[get_agent]` returning a TestModel-backed Agent, the assembled response must contain TestModel-distinctive output. If it doesn't, the override isn't wired through and we drop down to the manual `build_run_input` / `run_stream` / `encode_stream` flow. |

## References

- Progression plan §08 (Init) — [../plans/python-llm-app-progression.md#l0](../plans/python-llm-app-progression.md#l0)
- Progression plan §13.1 (Init DOD checklist)
- ADR-001, ADR-002, ADR-003, ADR-005 (all in §09)
- Invariants §I1, §I3, §I5, §I9
