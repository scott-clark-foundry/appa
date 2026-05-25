---
title: "pydantic-ai provider quirks (observed)"
status: living document
pydantic-ai-pin: 1.102.0
last-updated: 2026-05-24
sources: scripts/doe_provider_tuning.py, scripts/doe_verify_thinking_off.py, live runs against OpenAI / Anthropic / OpenRouter (Gemini, Kimi, DeepSeek, GLM)
---

# pydantic-ai provider quirks (observed)

pydantic-ai presents a unified Agent / Settings / capabilities surface across providers. In practice some of those abstractions leak. This doc catalogs the leaks we've hit live with **symptom → cause → workaround**, so future model upgrades or provider swaps read it first.

> **Read this before:** adding a new provider to `Settings.build_model()`, raising a model floor in `pyproject.toml`, swapping models in production, or debugging a provider-side 400.

## §1 — `Agent('openai:...')` silently uses Chat Completions, not Responses

**Symptom:** `openai_text_verbosity` rejected with `Unsupported parameter`. Native `WebSearchTool` rejected with `UserError: WebSearchTool is not supported with OpenAIChatModel`. gpt-5-family features generally unreachable.

**Cause:** The string-form `Agent('openai:gpt-5.4', ...)` resolves to `OpenAIChatModel` (Chat Completions API). The Responses API features (verbosity dial, reasoning summary, native web search) require `OpenAIResponsesModel`. pydantic-ai gives no warning about which endpoint the string-form selected.

**Workaround:** Construct the model explicitly when you need Responses-API features:
```python
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider
model = OpenAIResponsesModel("gpt-5.4", provider=OpenAIProvider(api_key=os.environ["OPENAI_API_KEY"]))
Agent(model, ...)
```

This is what `assistant/config.py::Settings.build_model()` does in production. The DOE script's first crash was caused by NOT doing this — used the string form and got Chat Completions instead.

## §2 — `thinking='minimal'` acceptance is per-model on the OpenAI side (not all "mini" variants)

**Symptom:** `ModelHTTPError 400: Unsupported value: 'minimal' is not supported with the 'gpt-5.4-mini' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh'.` Same prompt + setting works on `gpt-5-nano` and `gpt-5.4` (the full-size variant).

**Verified per-model:**
| Model | accepts `'minimal'`? | reasoning_tokens at 'minimal' |
|---|---|---|
| `openai:gpt-5-nano` | **✓** | 0 (truly off) |
| `openai:gpt-5.4` | ✓ | (small) |
| `openai:gpt-5.4-mini` | **✗ (400)** | — |

**Cause:** OpenAI's `reasoning.effort='minimal'` is supported on the original gpt-5 series (gpt-5-nano, gpt-5) and the new full gpt-5.4 — but **NOT on gpt-5.4-mini specifically**. pydantic-ai exposes 'minimal' in `ThinkingLevel` and forwards it as-is; the rejection happens server-side. No per-model validation in pydantic-ai.

**Workaround:**
- For `gpt-5-nano` (our production default): `Settings.MODEL_THINKING='minimal'` is correct and works.
- For `gpt-5.4-mini`: use `'low'` as the lowest-thinking value.
- For cross-provider portability: `'low'` is the safe-floor value (accepted by every reasoning model we tested).

**For our app:** `Settings.MODEL_THINKING='minimal'` (the current default) works for `gpt-5-nano`. If a future operator switches MODEL_NAME to `gpt-5.4-mini` without also lowering MODEL_THINKING, requests fail at runtime. Either add a per-model validator on Settings, or document this in the `.env.example` near MODEL_NAME.

## §3 — Anthropic requires `max_tokens > thinking.budget_tokens`

**Symptom:** `ModelHTTPError 400: 'max_tokens' must be greater than 'thinking.budget_tokens'.` Fires when Anthropic models have thinking enabled AND a max_tokens cap below the thinking budget.

**Cause:** Anthropic's API enforces this rule server-side; pydantic-ai doesn't pre-validate before sending the request. The `thinking='high'` budget on Haiku-4-5 is ~10000+ tokens; the default `max_tokens` pydantic-ai sends may be smaller.

**Workaround:** When enabling Anthropic thinking, explicitly set `max_tokens` to a value larger than the thinking budget. In our DOE we used `max_tokens=20000` on the `think-high` cell — well below the 64k context ceiling, comfortably above any thinking budget we've seen.

**For our app:** if MODEL_PROVIDER=anthropic AND MODEL_THINKING in ('high', 'xhigh'), ensure `MODEL_MAX_TOKENS` is set to ≥ 20000 in `.env`. Otherwise requests fail at runtime, not at config-load.

## §4 — Unified `thinking=False` is a no-op for OpenRouter (the workaround is one explicit knob away)

**Symptom:** Setting `model_settings={'thinking': False}` on `openrouter:moonshotai/kimi-k2.6` still produces 392+ reasoning tokens. On `openrouter:z-ai/glm-5.1` it has effectively zero effect. On `openrouter:deepseek/deepseek-v4-pro` it shows up inconsistently. Originally I read this as "abstraction broken, can't disable reasoning." **Wrong.**

**Cause** (read the source — `pydantic_ai/models/openrouter.py:559-573`):

```python
if 'openrouter_reasoning' not in model_settings and model_request_parameters.thinking is not None:
    thinking = model_request_parameters.thinking
    if thinking is not False:           # ← if False, the whole block is SKIPPED
        unified_reasoning = {}
        effort_map = {True: 'medium', 'minimal': 'low', 'low': 'low', ...}
        unified_reasoning['effort'] = effort_map[thinking]
        model_settings['openrouter_reasoning'] = unified_reasoning
```

When `thinking=False`, pydantic-ai sends **no `reasoning` parameter at all** to OpenRouter. For models that reason by default (Kimi, DeepSeek-V4-Pro, GLM-5.1), absence = "use provider default" = "keep reasoning on." pydantic-ai's `thinking=False` is "do not enable reasoning"; it is NOT "actively disable reasoning."

**Fix — use the OpenRouter-native knob explicitly:**

```python
model_settings={"openrouter_reasoning": {"enabled": False}}
# or equivalently
model_settings={"openrouter_reasoning": {"effort": "none"}}
```

**Verified by `scripts/doe_verify_thinking_off.py`** — same prompt across 4 OR OSS reasoning models, 5 variants per model:

| Model | baseline reasoning_tok | `thinking=False` | `openrouter_reasoning={"enabled": False}` |
|---|---|---|---|
| deepseek-v4-flash | 79 | 60 | **0** |
| deepseek-v4-pro | 184 | 0 (stochastic) | **0** |
| moonshotai/kimi-k2.6 | 428 | 392 | **0** |
| z-ai/glm-5.1 | 564 | 545 | **0** |

Both `{"enabled": False}` and `{"effort": "none"}` reliably zero out reasoning. **Output quality holds** — quick check on the multi-step train-meeting problem shows all four OSS models still step through the math correctly; they just do the reasoning in visible output tokens (with explicit "Step 1 / Step 2" labels) instead of hidden reasoning tokens. Same work, ~8-17× less total token volume.

**For our app:** `Settings.MODEL_EXTRA_SETTINGS` can carry this per-environment when MODEL_PROVIDER=openrouter and the model is a reasoning-capable OSS one:

```
MODEL_EXTRA_SETTINGS='{"openrouter_reasoning":{"enabled":false}}'
```

This brings the OR OSS chat-turn cost from "don't bother" to "potentially 40× cheaper than gpt-5.4-mini" (deepseek-v4-flash at $0.02/1k turns vs $0.80/1k for the proprietary winner). Quality validation across a real prompt corpus still needed before swapping the production default.

**Upstream note:** pydantic-ai's cross-provider `thinking=False` semantic could be improved — either map to `{"enabled": False}` for OR, OR document explicitly that "False = do not enable" not "False = disable." Worth a pydantic-ai issue once we've confirmed our usage pattern.

## §5 — OR OSS reasoning models default to reasoning ON (and produce a lot)

**Symptom:** `deepseek-v4-flash` baseline (no `thinking` setting): **5038 reasoning tokens + 5209 output tokens** for "What's the difference between TCP and UDP? Answer in one paragraph." Kimi-K2.6: 3941 reasoning + 4251 output. GLM-5.1: 1577 + 1810. Latency: **100-200 seconds**.

**Cause:** These models have reasoning enabled by default at the OpenRouter routing layer. Unlike OpenAI gpt-5 (where reasoning is off-or-minimal by default) or Anthropic (where thinking is explicitly opt-in), the OR OSS reasoners reason about everything.

**Workaround:** See §4 — `thinking=False` doesn't reliably disable. For chat-app use, switch to a non-reasoning OSS model (e.g. Kimi K2 base instead of K2.6 if available) or use a generous `max_tokens` cap as a backstop.

## §6 — pydantic-ai's "Model token limit exceeded before any response was generated"

**Symptom:** `UnexpectedModelBehavior: Model token limit (500) exceeded before any response was generated. Increase the max_tokens model setting, or simplify the prompt to result in a shorter response that will fit within the limit.`

**Cause:** raised by pydantic-ai (`_agent_graph.py:1104`) when a model response has used up the configured `max_tokens` but contains no `TextPart` — i.e. all the budget went to reasoning or tool calls. Common pattern: reasoning model with a small cap.

**Workaround:** Either raise `max_tokens` to allow text output after reasoning, or disable thinking (subject to §4). The error message hints at the right fix; not a pydantic-ai bug, just a brittle interaction.

## §7 — `WebSearch(local=True)` and `WebFetch(local=True)` need optional extras

**Symptom:** `UserError: WebFetch(local=True) requires the web-fetch optional group — pip install "pydantic-ai-slim[web-fetch]".` Same shape for `WebSearch(local='duckduckgo')`.

**Cause:** pydantic-ai's "local fallback" capabilities use markdownify (for WebFetch) and duckduckgo-search (for WebSearch). Neither ships with the base install. The error is at capability-construction time, which fires before the Agent is even built — so without try/except discipline, one missing extra crashes a whole script.

**Workaround:** Install both extras up front:
```bash
uv add 'pydantic-ai-slim[web-fetch,duckduckgo]'
```

Or: catch `UserError` at capability-construction time so one missing extra doesn't kill the run.

## §8 — `result.usage` was a method (1.101 and earlier), now a property (1.102+)

**Symptom:** `PydanticAIDeprecationWarning: AgentRunResult.usage is no longer a method; access it as a property (drop the parentheses).` Appears repeatedly during long runs.

**Cause:** API change between minor versions. Old code patterns `result.usage()` still work but emit deprecation warnings on every call.

**Workaround:** Always access as `result.usage` (property form). The `if callable(usage_obj): usage_obj = usage_obj()` backwards-compat dance in our DOE v0.2 triggered the warning even though it was meant to suppress it — `callable(property_result)` is True for the bound method that's returned in the transitional path.

## §9 — Native ImageGeneration tool is OpenAI-only (and pricey)

**Not directly tested in DOE** (substituted SVG-axolotl prompt as a cross-provider creative test). Worth knowing: `ImageGenerationTool` only registers on `OpenAIResponsesModel`. For cross-provider "creative output", use SVG-via-structured-output instead (which works on every model — see §8 of the DOE report).

## §10 — `usage.details` field names vary by provider

**Symptom:** Anthropic's `usage.details` does not expose `reasoning_tokens` even when thinking is enabled — the field stays at 0. OpenAI's `usage.details` has `reasoning_tokens` cleanly. OpenRouter exposes provider-passthrough fields that aren't documented anywhere.

**Workaround:** Don't rely on `reasoning_tokens` being present cross-provider. Capture the full `usage.details` dict (as our DOE does) and post-process per-provider. For accurate cross-provider cost accounting, prefer `result.usage.input_tokens` + `result.usage.output_tokens` (both reliable) and treat reasoning tokens as a bonus when present.

## Open questions for future runs

- **Provider-specific `thinking` mapping table.** Sample more OR models to map exactly how pydantic-ai's `thinking` value translates per backend. Currently only point estimates per model.
- **Anthropic `thinking` budget formula.** What's the relationship between `thinking='low'` and the actual budget_tokens Anthropic uses? Unclear; the API request hides it inside the beta thinking config.
- **`openai_text_verbosity='high'` < baseline output** on gpt-5.4-mini. Did the dial misinterpret as a ceiling, or is this stochastic? Re-run at n=10.
- **DeepSeek-V4-Pro thinking-inversion** (no-settings: 0 reasoning, thinking=False: 61 reasoning). Whyyyy.

## Adding to this doc

When you hit a new pydantic-ai abstraction leak in the wild:
1. Capture the exact error message (`raise` text, status code, model name)
2. Add a `§` section with symptom / cause / workaround
3. Reference any verification script or live capture file
4. Update the frontmatter `last-updated`

This doc compounds value over time. Every quirk discovered once saves a future debugging session.
