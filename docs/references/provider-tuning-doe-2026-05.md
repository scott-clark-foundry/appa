---
title: "Provider tuning DOE — 2026-05 rules of thumb"
status: complete
ran-on: 2026-05-24
script: scripts/doe_provider_tuning.py (v0.3.1)
data: vault/doe/runs.csv (272 rows, $1.58 spent)
html-appendix: docs/references/provider-tuning-doe-2026-05.html
quirks-doc: docs/references/pydantic-ai-provider-quirks.md
---

# Provider tuning — rules of thumb

One-pager distilled from a 9-model, 5-prompt, 6-cell, 4-built-in DOE. The HTML appendix has the full tables, charts, and SVG axolotls. The quirks doc has the abstraction-leak findings.

**Run summary:** 272 calls, 25 errors (all on OR OSS reasoning models — see Rule 4), $1.58 total. Captures: token counts, latency, cost, full message exchange (`.messages.json`), outgoing request via Hooks (`.requests.jsonl`), raw HTTPS via Logfire `instrument_httpx(capture_all=True)`, trace_id-joined across all layers. Caveat: **n=1 per cell**, so all numbers below are point estimates not means.

## Rules

### 1. For chat-app turns (want short answers, low cost, fast latency)

**Use `openai:gpt-5-nano` with `MODEL_THINKING='minimal'` AND `MODEL_EXTRA_SETTINGS='{"openai_text_verbosity":"low"}'`.** Measured on 3 short chat-shape prompts (TCP/UDP, Big-O, list comprehension): **97 output tokens, 0 reasoning tokens, $0.04/1k turns, 1.6s latency**. This is our actual production default model — and our `Settings.MODEL_THINKING='minimal'` already does the right thing; just add the verbosity dial.

**Quality-validated cheap alternatives** (within an order of magnitude, but not measurably better and require setup):
- `openrouter:deepseek/deepseek-v4-flash` + `{"openrouter_reasoning":{"enabled":false}}` — $0.02/1k turns (40% cheaper) but quality validated only on 2 prompts; needs a broader eval before swapping production.
- `openrouter:google/gemini-3.1-flash-lite` baseline — $0.70/1k turns (more verbose, slower).

**Why I had this wrong initially:** I used a recent table of models from scott that listed `gpt-5.4-mini` and **omitted `gpt-5-nano` entirely**, even though `gpt-5-nano` is our actual `Settings.MODEL_NAME` default. Lesson: always cross-check the model lineup against the current `.env`. gpt-5-nano is ~10× cheaper per output token than gpt-5.4-mini ($0.40 vs $4.50 per 1M).

### 2. For reasoning quality (multi-step problems, code with constraints)

**Use `openai:gpt-5.4` with `thinking='high'`.** Measured: 332 output + 114 reasoning tokens, $0.0051/call, 4.9s. The thinking budget reliably lifts answer quality on the multistep-reasoning prompt; baseline gpt-5.4 still solves it but with less explicit step-showing. 1.4x cost vs baseline.

Avoid: any OR OSS reasoning model for this — they over-think (5000-6000 reasoning tokens), 100+ second latency, and the verbose answer rarely scores higher than gpt-5.4's tighter response.

### 3. Anthropic Haiku is **not** the lightweight chat option you'd think

Surprise finding: at baseline, **Haiku is SLOWER (9.3s) than Sonnet (6.1s)** for our test prompts, and **2x more verbose** (1305 output tokens vs 336). Haiku-with-`hard-cap-500` is the rescue — cuts cost 71% ($0.0066 → $0.0019) and latency to 3.4s. Sonnet baseline is genuinely solid: $0.0052/call, 6.1s, ~336 tokens — directly competitive with gpt-5.4-mini for chat at similar price-per-token.

### 4. OR OSS reasoning models — viable for chat with the right knob (and potentially 40× cheaper)

**Updated finding (replaces my initial "batch tools only" claim).** The 100-second latency and 5000-token responses I observed on deepseek-v4-flash/pro, kimi-k2.6, and glm-5.1 at baseline weren't intrinsic to the models — they were because reasoning was on by default. pydantic-ai's unified `thinking=False` is a no-op for OpenRouter (sends no reasoning param; OR models with reasoning-by-default keep reasoning). The correct knob is the OR-native one:

```python
model_settings={"openrouter_reasoning": {"enabled": False}}
# or
model_settings={"openrouter_reasoning": {"effort": "none"}}
```

Both reliably zero reasoning tokens. Verified by `scripts/doe_verify_thinking_off.py`. Quality holds — the OSS models still step through multi-step problems correctly, they just produce visible step labels in the output instead of burning hidden reasoning tokens. Total token volume drops ~8-17×.

In .env: `MODEL_EXTRA_SETTINGS='{"openrouter_reasoning":{"enabled":false}}'` when MODEL_PROVIDER=openrouter and the model is a reasoning-capable OSS one.

**Measured cost-per-call on `factual-short` with reasoning off:**

| Model | input | output | $/call | $/1k turns |
|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 18 | 92 | $0.00002 | **$0.02** |
| `deepseek/deepseek-v4-pro` | 18 | 120 | $0.00011 | $0.11 |
| `z-ai/glm-5.1` | 19 | 138 | $0.00044 | $0.44 |
| `moonshotai/kimi-k2.6` | 22 | 155 | $0.00056 | $0.56 |
| (for comparison) `openai:gpt-5.4-mini + verbose-low` | 49 | 163 | $0.00080 | $0.80 |

DeepSeek-V4-Flash with reasoning off is **40× cheaper** than the proprietary chat winner. **Quality validation across a real prompt corpus still needed** before defaulting production to it — but the cost differential is large enough to justify the eval.

See quirks doc §4 for the why (pydantic-ai's OR mapping skips the reasoning param when `thinking=False`).

### 5. The `thinking` dial: which models honor it cross-provider?

From measured `reasoning_tokens` at baseline:

| Model | `thinking` honored? | `'minimal'` accepted? | Baseline reasoning tok |
|---|---|---|---|
| openai:gpt-5-nano | ✓ | **✓** (0 reasoning at minimal) | 427 (at 'low') / 0 (at 'minimal') |
| openai:gpt-5.4-mini | ✓ | **✗** (400 from API; supports 'low' and up only — see quirks §2) | 68 |
| openai:gpt-5.4 | ✓ | ✓ | 28 |
| anthropic:claude-haiku-4-5 | ✓ but no reasoning_tokens exposed | ✓ | (not exposed in usage.details) |
| anthropic:claude-sonnet-4-6 | ✓ but no reasoning_tokens exposed | ✓ | (not exposed) |
| google/gemini-3.1-flash-lite | ✓ | ✓ | 127 |
| deepseek/deepseek-v4-flash | ✓ for raising; ✗ for `False` (see quirks §4) | n/a | 5038 |
| deepseek/deepseek-v4-pro | ✓ for raising; ✗ for `False` | n/a | 6034 |
| moonshotai/kimi-k2.6 | ✓ for raising; ✗ for `False` | n/a | 3941 |
| z-ai/glm-5.1 | ✓ for raising; ✗ for `False` | n/a | 1577 |

**The `False` direction matters and pydantic-ai's unified field does NOT propagate it to OpenRouter.** Use `openrouter_reasoning={"enabled": False}` instead — see Rule 4 above and quirks doc §4. Anthropic separately doesn't surface `reasoning_tokens` in `usage.details` even when thinking is on, so cross-provider reasoning-token accounting is partial.

### 6. `openai_text_verbosity` works (gpt-5 family only)

Measured on `openai:gpt-5.4-mini`:
- baseline: 296 tokens / $0.0014
- verbose-low: **163 tokens / $0.0008** ← biggest single win for chat use
- verbose-high: 224 tokens / $0.0010 (oddly less than baseline)

The "verbose-high produced less than baseline" is unexplained — possibly the model interpreted the dial as a "verbosity ceiling" rather than a target. Worth a focused follow-up at n>1.

### 7. `hard-cap-500` is the universal escape hatch

Works cleanly on every direct-provider model (OpenAI + Anthropic + Google) without errors. Cuts cost 25-71%. **Use it as the default ceiling** in production handlers where you don't want users running away with the bill — it's a graceful constraint on the proprietary models. On OR OSS reasoning models it's a footgun (see Rule 4).

### 8. SVG generation: structured output is the unlock

Visual axolotls in the HTML appendix. Summary:
- **Plain string output**: most models return SVG wrapped in markdown code fences or with leading commentary that breaks parsing. Haiku's plain SVG was INVALID for this reason.
- **Structured output (`output_type=SvgOutput(svg: str)`)**: every model produces parse-valid SVG. The Pydantic schema acts as the format-following guarantor.

Practical: when you need a model to emit machine-readable content (SVG, JSON, CSV, structured data), define an `output_type` rather than asking nicely in the prompt.

### 9. Built-in WebSearch: native works, local-fallback needs setup

Native WebSearch (`WebSearch(native=True)`) works on OpenAI, Anthropic, Google direct, and via OpenRouter's `:online` plugin for OSS models. Returns useful results. Provider fees apply ($30/1k OpenAI, $10/1k Anthropic) — not in our token-cost column.

Local fallback (`WebSearch(local=True)`) needs `pydantic-ai-slim[duckduckgo]` extras package; I had only installed `[web-fetch]`. **Add `[duckduckgo]` next time** for the cross-provider fallback path.

### 10. Compaction (`ProcessHistory`) works as expected

The 13-turn compaction test (drop all but last 5) shows the callback question reliably fails OR returns a hallucinated answer when context is trimmed. Not surprising, but confirms pydantic-ai's `ProcessHistory` capability propagates correctly across providers.

## Cost projections (1k chat turns)

Assuming ~400-token input + the per-model output baseline from §1-3:

| Model | Best chat config | $/1k turns | Quality validated? |
|---|---|---|---|
| **openai:gpt-5-nano** | `thinking=minimal` + `verbose-low` | **$0.04** | **✓ (production default, smoke + DOE)** |
| openrouter:deepseek/deepseek-v4-flash | `openrouter_reasoning:{enabled:false}` | $0.02 | partial (2 prompts) |
| openrouter:deepseek/deepseek-v4-pro | `openrouter_reasoning:{enabled:false}` | $0.11 | partial |
| openai:gpt-5-nano | baseline (thinking=low) | $0.10 | ✓ (DOE-tested across cells) |
| openrouter:z-ai/glm-5.1 | `openrouter_reasoning:{enabled:false}` | $0.44 | partial |
| openrouter:moonshotai/kimi-k2.6 | `openrouter_reasoning:{enabled:false}` | $0.56 | partial |
| openrouter:google/gemini-3.1-flash-lite | baseline | $0.70 | ✓ (DOE-tested) |
| openai:gpt-5.4-mini | `verbose-low` | $0.80 | ✓ (DOE-tested) — but more expensive than gpt-5-nano for same shape of output |
| anthropic:claude-haiku-4-5 | `hard-cap-500` | $1.90 | ✓ (DOE-tested) |
| openai:gpt-5.4 | `hard-cap-500` | $2.70 | ✓ (DOE-tested) |
| anthropic:claude-sonnet-4-6 | baseline | $5.20 | ✓ (DOE-tested) |

**Recommended production defaults (today):**
- **For chat:** `openai:gpt-5-nano` with `MODEL_THINKING='minimal'` (already our default) + `MODEL_EXTRA_SETTINGS='{"openai_text_verbosity":"low"}'`. Proven-quality production model at **$0.04/1k turns, 1.6s latency**.
- **For reasoning-heavy prompts:** `openai:gpt-5.4` + `thinking=high`. ~$2.70/1k for that quality tier.
- **Worth evaluating for further savings:** `openrouter:deepseek/deepseek-v4-flash` + `openrouter_reasoning:{enabled:false}` — 50% cheaper than the chat default, but quality validated only on 2 prompts. Worth ~50 representative prompts of human-grading time to clear for production.

## What we did NOT measure

- **Quality** beyond format-following (no human grading pass — would need n>1 per cell to be meaningful)
- **Variance** (each cell ran once; some failures may be stochastic — DeepSeek-V4-Pro's cap-500 failed in the main DOE but passed in the verification smoke on a different prompt)
- **Long context** (all prompts < 100 input tokens)
- **Server-side tool fees** (OpenAI/Anthropic web search fees show on the bill, not our token cost)
- **Image generation** (deliberately skipped; SVG-axolotl substituted)
- **File search, MCP, Memory tool** (require setup beyond DOE scope)

## See also

- `docs/references/provider-tuning-doe-2026-05.html` — full data appendix with charts and the SVG axolotl gallery
- `docs/references/pydantic-ai-provider-quirks.md` — the abstraction-leak findings (where pydantic-ai's cross-provider promises break)
- `scripts/doe_provider_tuning.py` — re-runnable harness
- `scripts/doe_summarize.py` — regenerate markdown summary tables
- `scripts/doe_html_report.py` — regenerate HTML appendix
- `scripts/doe_verify_thinking_off.py` — the Rule 5 verification smoke
- `vault/doe/runs.csv` + per-call meta.json + messages.json + requests.jsonl
