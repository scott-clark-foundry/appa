---
title: "Tuning DOE 2026-05: cross-provider knobs + measured rules of thumb"
summary: "Retrospective for the cross-provider tuning surface and the 9-model × 6-cell DOE that landed after phase 1 transcripts. A short .env change spiked into a measured one-pager of chat-config rules and a catalog of pydantic-ai abstraction leaks."
status: complete
author: Scott Clark
phase: "1 of 10 (extensions)"
spec: n/a (retrospective; no upfront spec)
progression: "progression #l1"
branch: feat/tunable-defaults (squash-merged to main as PR #5, commit 6730eb6)
started: 2026-05-24
tags: [phase-1, retrospective, tuning, doe, provider-quirks, observability]
---

# Tuning DOE 2026-05: cross-provider knobs + measured rules of thumb

_Retrospective for the cross-provider tuning surface and 9-model DOE that landed between phase 1's merge and the start of phase 2. Five iterations the master progression plan didn't anticipate, plus the reference docs they produced._

## 01. Intent

Phase 1 (transcripts) shipped with the conversation surface working end-to-end on a `Settings` shape that exposed only `MODEL_PROVIDER` + `MODEL_NAME`. An attempt to "spend five minutes lowering chat cost in `.env`" surfaced enough pydantic-ai abstraction leaks to warrant a structured tuning surface, a measured one-pager of cross-provider rules-of-thumb, and a living quirks catalog.

What this doc is *not*: a plan to execute. The work has shipped on `origin/main` as PR #5. This is a retrospective ledger so the master progression plan stays legible without spelunking git log.

## 02. Iterations

### Iteration A — Cross-provider tuning surface on `Settings`

**Trigger.** `.env` carried `MODEL_PROVIDER` + `MODEL_NAME` and nothing else. Setting `thinking`, `max_tokens`, `temperature`, or any provider-specific knob (verbosity, reasoning effort) required code edits. The chat surface had no operator-visible cost dial.

**Resolution.** New typed fields on `Settings` (`assistant/config.py`):

- `MODEL_MAX_TOKENS`, `MODEL_TEMPERATURE`, `MODEL_THINKING` (default `'minimal'`, always on so reasoning-token usage shows in transcripts), `MODEL_TIMEOUT`.
- `MODEL_EXTRA_SETTINGS: dict[str, Any]`, JSON-parsed from `.env`, escape hatch for provider-specific knobs (`openai_text_verbosity`, `openrouter_reasoning`, etc.).
- `DEFAULT_INSTRUCTIONS` reaches the model on every run via `build_agent`.

New `Settings.build_model_settings()` composer merges typed + extras into a `ModelSettings` TypedDict; extras shallow-merge over typed so an operator can override per-environment.

The contract: **typed = portable, extras = provider-locked.** An extras key like `openai_text_verbosity` silently no-ops on Anthropic. That is the price of the escape hatch and it is worth it.

### Iteration B — OpenAI Responses API swap

**Trigger.** `openai_text_verbosity` rejected with `Unsupported parameter`. Native `WebSearchTool` rejected with `UserError: WebSearchTool is not supported with OpenAIChatModel`. Both because the string-form `Agent('openai:...')` silently resolves to `OpenAIChatModel` (Chat Completions API), not `OpenAIResponsesModel`.

**Resolution.** `Settings.build_model()` now constructs `OpenAIResponsesModel` explicitly with `OpenAIProvider(api_key=...)`. Unlocks `openai_text_verbosity`, `openai_reasoning_summary`, native `WebSearchTool`. Documented as quirk §1 in the provider-quirks doc; do not refactor back to the string form.

### Iteration C — Observability consolidation

**Trigger.** Two parallel logging layers (`structlog` for app logs, Logfire for pydantic-ai traces) produced double-emitted events in some flows, and structlog was not actually load-bearing anywhere phase 1 cared about.

**Resolution.** Dropped the `structlog` direct dependency. Logfire is the single observability layer: `logfire.instrument_pydantic_ai()` (auto `gen_ai.*` spans around `Agent.run`), `logfire.instrument_httpx(capture_all=True)` (every outbound HTTPS request as a span, including raw bodies), `logfire.instrument_fastapi(app)` (every FastAPI route as a span). All three families join on `trace_id`. For stdout-only logs without Logfire, set `console=True` on `logfire.configure()`.

### Iteration D — 9-model × 6-cell DOE

**Trigger.** With the tuning surface live, the obvious question: which model + setting combo is best for our chat shape? Iterations A through C made it easy to test cells.

**Resolution.** `scripts/doe_provider_tuning.py` (v0.3.1): 9 models × 5 prompts × 6 cells × 4 built-ins. 272 calls, 25 errors (all on OR OSS reasoning models with `thinking=False`, see quirk §4), $1.58 total spend. Per-call captures:

- Full `ModelMessage` exchange (`.messages.json`).
- Outgoing request via pydantic-ai Hooks (`.requests.jsonl`).
- Raw HTTPS via Logfire `instrument_httpx(capture_all=True)`.
- Response metadata, SVG validity, reproducibility metadata.
- `trace_id`-joined across all three capture layers.

Companion scripts: `doe_html_report.py` (Tailwind + Chart.js + embedded SVG axolotl gallery, single self-contained HTML), `doe_summarize.py` (regenerates markdown tables), `doe_verify_thinking_off.py` (5-variant focused smoke that disproved an early wrong finding about OpenRouter reasoning).

**Headline finding.** Recommended chat config: `openai:gpt-5-nano` + `MODEL_THINKING='minimal'` + `MODEL_EXTRA_SETTINGS='{"openai_text_verbosity":"low"}'`. Measured: 97 output tokens, 0 reasoning tokens, **$0.04 per 1k chat turns**, 1.6s latency. Our existing default `MODEL_THINKING='minimal'` already does the right thing; just adding the verbosity dial cut cost 60%.

**Caveat baked into the doc.** n=1 per cell, no human grading pass on quality, no variance estimate. Every number in the one-pager is a point estimate, not a mean.

### Iteration E — Documentation

- `docs/references/provider-tuning-doe-2026-05.md` — one-page rules of thumb backed by the DOE data. Read this before reasoning about cost or latency tradeoffs across providers.
- `docs/references/provider-tuning-doe-2026-05.html` — visual appendix (Tailwind + Chart.js + SVG gallery, single self-contained file).
- `docs/references/pydantic-ai-provider-quirks.md` — 10 abstraction-leak findings (symptom / cause / workaround). Living document; appended when new leaks surface. Loadbearing: §1 (Responses API silent default), §2 (`gpt-5.4-mini` rejects `'minimal'`), §3 (Anthropic `max_tokens > thinking.budget_tokens`), §4 (OpenRouter `thinking=False` is a no-op).
- `NOTES.md` gained "Tuning surface as the cross-provider lever (unreleased)" section.
- `CHANGELOG.md` `[Unreleased]` populated. Final version assigned at next merge (decoupled from any phase number).

## 03. State at close

PR #5 squash-merged to `main` as commit `6730eb6`. Local `main` was briefly ahead of `origin/main` by one docs commit (`4465e26 docs(session): tbc-notes for post-phase-1+tuning merge; pin pydantic-ai skill`). 98 tests green. CHANGELOG `[Unreleased]` awaiting version assignment at next merge.

The chat surface is now operationally sound: observable cost via reasoning tokens, observable history via JSONL, a tunable knob path for both portable and provider-locked settings. It is **not** "fully explored" (see §04).

## 04. What didn't happen (and why)

Verbatim from the implementer's wrap-up tbc-notes — dimensions deliberately not measured in the DOE, named here so the next session does not accidentally re-promise "complete":

- Native image generation (substituted with SVG-axolotl prompt as a cross-provider creative test).
- MCP integration, Anthropic Memory tool, computer use, prompt caching.
- Long-context behavior (all DOE prompts < 100 input tokens).
- Run variance (each cell ran once; some failures may be stochastic).
- More OR models (Qwen, Llama).
- Provider tier / service options.
- Streaming via `/chat` for non-trivial flows.
- File search, structured-output × thinking interaction.

**Going-forward bar.** Further DOE work needs explicit ROI sign-off, not "have we explored everything." The spike is done.

**Open questions deferred to future runs** (from the quirks doc §Open questions):

- Sample more OR models to map exactly how pydantic-ai's `thinking` value translates per backend.
- Anthropic `thinking='low'` budget formula (hidden in the beta thinking config).
- `openai_text_verbosity='high'` produced fewer tokens than baseline on gpt-5.4-mini. Stochastic, or did the dial misinterpret as a ceiling? Re-run at n=10.
- DeepSeek-V4-Pro thinking-inversion (no-settings: 0 reasoning, `thinking=False`: 61 reasoning). Unexplained.

## 05. Pointers

- References: `docs/references/provider-tuning-doe-2026-05.md`, `docs/references/provider-tuning-doe-2026-05.html`, `docs/references/pydantic-ai-provider-quirks.md`.
- Source touched: `assistant/config.py` (`Settings.MODEL_*`, `build_model_settings`, `build_model` with `OpenAIResponsesModel`), `assistant/agent.py` (`build_agent` threads `model_settings` + `instructions`), `assistant/logging_setup.py` (Logfire-only).
- Scripts: `scripts/doe_provider_tuning.py`, `doe_summarize.py`, `doe_html_report.py`, `doe_verify_thinking_off.py`.
- Data: `vault/doe/runs.csv` (272 rows, gitignored).
- PR: #5 `feat: cross-provider tuning surface + provider DOE` (squash-merged at `6730eb6`).
- CHANGELOG: `[Unreleased] - tuning surface + cross-provider DOE` (awaiting final version).
- NOTES: `## Tuning surface as the cross-provider lever (unreleased)`.
- Adjacent retrospective: `02-post-scaffold-iteration.md` (PRs #2 and #3, between phase 0 and phase 1).
