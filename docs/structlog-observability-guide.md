# structlog Observability Guide

**TL;DR**: Use structlog with a privacy-scrubbing processor and RotatingFileHandler for JSONL output. All log events are machine-queryable with `jq`. Logfire/OpenTelemetry is a 3-step, 3-line migration requiring no changes to logger call sites.

**Versions**: structlog v25.5.0, logfire v4.25.0, pydantic-ai v1.62.0

---

## Contents

1. [Why structlog over Logfire](#why-structlog-over-logfire)
2. [Quick Start](#quick-start)
3. [Core Configuration](#core-configuration)
4. [Privacy Scrubbing Processor](#privacy-scrubbing-processor)
5. [Correlation Middleware](#correlation-middleware)
6. [Log Event Patterns](#log-event-patterns)
7. [Cost Tracking](#cost-tracking)
8. [What to Log / What Not to Log](#what-to-log--what-not-to-log)
9. [Example Log Output](#example-log-output)
10. [Query Cookbook](#query-cookbook)
11. [Environment and Deployment](#environment-and-deployment)
12. [Log Rotation and Retention](#log-rotation-and-retention)
13. [OpenTelemetry Migration Path](#opentelemetry-migration-path)
14. [Testing Logging Behavior](#testing-logging-behavior)

---

## Why structlog over Logfire

Two viable paths exist for structured observability in a Pydantic AI agent application:

1. **structlog** with manual logging and a file-based JSONL sink
2. **Pydantic AI + Logfire** with automatic OTel tracing

Logfire (path 2) is more capable for production: zero manual span code, automatic token/cost capture, and first-class distributed tracing. However, it requires a cloud dependency or self-hosted OTel infrastructure.

**structlog is the right default because**:

- No external cloud dependency for initial deployment
- Full control over log retention, redaction, and access
- Logfire migration is a 3-step, ~3-line change — no changes to `logger.info()` call sites required
- structlog Issue #715 credential exposure risk is mitigated by `show_locals=False`, which this pattern enforces

**When to migrate to Logfire**: when structured log query time exceeds ~5 minutes for typical debugging sessions, when multi-service distributed tracing is needed, or when GDPR log deletion requirements necessitate a system with per-record deletion capability (JSONL files require full rewrite to remove a specific user's entries).

---

## Quick Start

```bash
uv add structlog
```

```python
# main.py — call once at application startup, before creating any loggers
from myapp.logging_config import configure_logging

configure_logging(log_level="INFO", json_output=True)
```

---

## Core Configuration

```python
# myapp/logging_config.py
# Requires: structlog>=25.0.0, Python>=3.10
# Install: uv add structlog

import logging
import logging.handlers
import os
import re
import structlog
from typing import Any


def configure_logging(
    log_path: str = "/var/log/myapp/app.jsonl",
    log_level: str = "INFO",
    max_bytes: int = 50 * 1024 * 1024,   # 50 MB per file
    backup_count: int = 10,               # 10 backups = 550 MB max on disk
    json_output: bool = True,
) -> None:
    """
    Configure structlog for production or development use.

    Args:
        log_path: Output file path (production JSONL mode only).
        log_level: Minimum log level. Use "DEBUG" in development, "INFO" in production.
        max_bytes: Maximum bytes per log file before rotation.
        backup_count: Number of rotated files to retain.
        json_output: True for JSONL production output, False for console (development).

    Key decisions:
    - merge_contextvars MUST be the first processor: contextvars bound in middleware
      are visible in all subsequent log calls without passing them explicitly.
    - show_locals=False in ExceptionDictTransformer prevents credential and
      connection-string leakage (structlog Issue #715).
    - cache_logger_on_first_use=True: performance optimization; do not set if using
      multiprocessing.
    - make_filtering_bound_logger: returns None on filtered levels — maximally fast.

    Call once at application startup, before creating any loggers.
    """
    level = getattr(logging, log_level.upper(), logging.INFO)

    if not json_output:
        # Development: human-readable console output
        structlog.configure(
            processors=[
                structlog.contextvars.merge_contextvars,
                structlog.processors.add_log_level,
                structlog.processors.TimeStamper(fmt="iso"),
                structlog.dev.set_exc_info,
                structlog.dev.ConsoleRenderer(),
            ],
            wrapper_class=structlog.make_filtering_bound_logger(level),
            cache_logger_on_first_use=True,
        )
        return

    # Production: JSONL via RotatingFileHandler
    timestamper = structlog.processors.TimeStamper(fmt="iso")

    pre_chain = [
        structlog.contextvars.merge_contextvars,   # Must be first
        structlog.processors.add_log_level,
        timestamper,
    ]

    structlog.configure(
        processors=pre_chain + [
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # ProcessorFormatter runs on both structlog and stdlib log records.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=pre_chain,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.StackInfoRenderer(),
            # show_locals=False: prevents credential/connection-string leakage
            # via local variable dumps in tracebacks.
            # Source: structlog Issue #715 (github.com/hynek/structlog/issues/715)
            structlog.processors.ExceptionRenderer(
                structlog.tracebacks.ExceptionDictTransformer(show_locals=False)
            ),
            scrub_sensitive_fields,   # Privacy: remove PII before render
            structlog.processors.JSONRenderer() if json_output else structlog.dev.ConsoleRenderer(),
        ],
    )

    handler = logging.handlers.RotatingFileHandler(
        log_path,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)

    # Also surface logs on stderr for development visibility when json_output=False
    if not json_output:
        stderr_handler = logging.StreamHandler()
        stderr_handler.setFormatter(formatter)
        root.addHandler(stderr_handler)
```

> ⚠️ `show_locals=False` is **mandatory**. structlog Issue #715 confirmed that local variables in tracebacks expose database connection strings, API keys, and other secrets stored in local variables. Never change this to `True` in production.

---

## Privacy Scrubbing Processor

The `scrub_sensitive_fields` processor runs on every log event before rendering. Place it after `merge_contextvars` and before the final renderer.

```python
# myapp/logging_config.py (continued)

# Fields that must never appear in logs under any circumstances.
# Extend this list as the data model evolves.
_FORBIDDEN_FIELDS = frozenset({
    "api_key", "authorization", "password", "token", "secret",
    "access_token", "refresh_token", "session_token",
    "credit_card", "ssn", "date_of_birth",
})

_EMAIL_PATTERN = re.compile(r"\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b", re.IGNORECASE)
_API_KEY_PATTERN = re.compile(r"(?i)(api[_-]?key|bearer|authorization)[\"'\s:=]+\S+")


def scrub_sensitive_fields(logger: Any, method: str, event_dict: dict) -> dict:
    """
    Structlog processor that:
    1. Removes any field in _FORBIDDEN_FIELDS unconditionally.
    2. Redacts email addresses from string field values.
    3. Drops the event entirely if an API key pattern is detected in a string value.

    Place AFTER merge_contextvars but BEFORE the renderer.

    This is the belt-and-suspenders defense against structlog Issue #715.
    The primary defense is show_locals=False in ExceptionDictTransformer; this
    processor handles cases where credentials are passed as log fields directly.
    """
    # Remove forbidden keys entirely
    for field in _FORBIDDEN_FIELDS:
        event_dict.pop(field, None)

    # Scan string values for PII patterns
    for key, value in list(event_dict.items()):
        if isinstance(value, str):
            if _EMAIL_PATTERN.search(value):
                event_dict[key] = _EMAIL_PATTERN.sub("[EMAIL REDACTED]", value)
            if _API_KEY_PATTERN.search(value):
                # Drop the entire event — the calling code needs to be fixed
                raise structlog.DropEvent()

    return event_dict
```

> ⚠️ The `_FORBIDDEN_FIELDS` set is static and must be manually extended as the data model evolves. Treat it as a living list — review it whenever new credential or identity fields are added.

### GDPR Notes

- Email addresses in string values are automatically redacted to `[EMAIL REDACTED]`.
- Events containing API key patterns in any string value are dropped entirely — fix the calling code rather than trying to scrub partially.
- `show_locals=False` prevents traceback local variable dumps from leaking credentials.
- JSONL files do **not** support per-record deletion. GDPR Article 17 (right to erasure) cannot be satisfied by targeting individual log entries — the entire file must be rewritten, or logs must not contain identifying fields in the first place. Log aggregate metrics, not raw user-identifiable content.
- GDPR Article 5(1)(e) (storage limitation): 30-day rolling retention is the recommended default. See [Log Rotation and Retention](#log-rotation-and-retention).

---

## Correlation Middleware

Binds a unique `run_id` to every HTTP request via structlog contextvars, making it available in all log calls within that request's context without passing it explicitly.

```python
# myapp/middleware.py
import uuid
import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class CorrelationMiddleware(BaseHTTPMiddleware):
    """
    Binds a unique run_id to structlog contextvars for every HTTP request.

    Add to FastAPI app:
        app.add_middleware(CorrelationMiddleware)

    Middleware ordering in FastAPI: last added = outermost.
    Add this before other middleware to ensure run_id is bound first.

    IMPORTANT: clear_contextvars() at request start prevents context leakage
    between concurrent requests in async context. This is confirmed async
    behavior documented in structlog's contextvars section.
    """

    async def dispatch(self, request: Request, call_next):
        # Clear all contextvars at request start to prevent leakage
        structlog.contextvars.clear_contextvars()

        run_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
        structlog.contextvars.bind_contextvars(
            run_id=run_id,
            http_method=request.method,
            http_path=request.url.path,
            # Do NOT bind: user IDs, IP addresses, or auth tokens
        )

        response = await call_next(request)
        structlog.contextvars.clear_contextvars()
        return response
```

> ⚠️ `clear_contextvars()` at the **start** of every request is not optional. Without it, context from a previous request can bleed into a new request when async workers are reused. Call it before binding any new context, not just at the end.

---

## Log Event Patterns

### Defining Your Event Taxonomy

Define a table of the events your application emits. Each row should capture: event name, level, key fields, and when it is emitted. Example structure:

| Event | Level | Key Fields | When |
|-------|-------|-----------|------|
| `tool.called` | INFO | `tool`, `run_id`, `retry` | When an agent tool is invoked |
| `tool.completed` | INFO | `tool`, `run_id`, `duration_ms`, result metrics | On tool success |
| `tool.failed` | ERROR | `tool`, `run_id`, `error_type`, `duration_ms` | On tool exception |
| `agent.run.cost` | INFO | `run_id`, `model`, `input_tokens`, `output_tokens`, `estimated_cost_usd` | After each `agent.run()` |
| `network.exhausted` | WARNING | `tool`, `attempts` | All retries consumed |
| `rate_limit.hit` | WARNING | `wait_seconds`, `limit`, `remaining` | HTTP 429 received |
| `auth.failure` | ERROR | `provider`, `auth_type` | Auth irrecoverably failed |
| `config.missing` | ERROR | `key` | Required env var not set |

Use the `event` field as the primary filter key in all `jq` queries.

### Tool Call Pattern

```python
# myapp/tools.py
import time
import structlog
from pydantic_ai import RunContext

logger = structlog.get_logger(__name__)


@agent.tool
async def fetch_thread(ctx: RunContext[AppDeps], thread_uri: str) -> dict:
    run_id = ctx.run_id   # str | None — from Pydantic AI RunContext
    start_ns = time.perf_counter_ns()

    # Bind tool-level context once; all log calls below inherit it automatically.
    # Do NOT bind: user handles, post content, email addresses, or full URIs.
    log = logger.bind(
        tool="fetch_thread",
        run_id=run_id,
        retry=ctx.retry,
        max_retries=ctx.max_retries,
    )

    # Log sanitized parameters only — truncate long identifiers, never log content.
    log.info(
        "tool.called",
        uri_prefix=thread_uri[:50] if thread_uri else None,
    )

    try:
        result = await ctx.deps.acl.get_thread(uri=thread_uri)
        duration_ms = (time.perf_counter_ns() - start_ns) / 1_000_000

        log.info(
            "tool.completed",
            reply_count=len(result.replies) if result else 0,
            duration_ms=round(duration_ms, 2),
            # DO NOT LOG: result content, post text, author handles, DIDs
        )
        return result.model_dump() if result else {}

    except Exception as exc:
        duration_ms = (time.perf_counter_ns() - start_ns) / 1_000_000
        log.error(
            "tool.failed",
            error_type=type(exc).__name__,
            duration_ms=round(duration_ms, 2),
            # exc_info=True logs full traceback. Safe only because show_locals=False
            # is set in ExceptionRenderer above — locals are never serialized.
            exc_info=True,
        )
        raise
```

---

## Cost Tracking

Log LLM token usage and estimated cost after every agent run. This enables `jq`-based budget monitoring with no additional infrastructure.

```python
# myapp/tools.py (continued)

async def run_agent_with_cost_logging(user_prompt: str, deps: AppDeps) -> str:
    result = await agent.run(user_prompt, deps=deps)
    usage = result.usage()

    # Pydantic AI RunUsage fields (v1.x):
    #   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    #   requests (number of LLM API calls), tool_calls (number of tool executions)
    # Source: https://ai.pydantic.dev/api/usage/

    # Cost formula: provider-reported token counts × per-token rates.
    # Rates must be updated manually as providers change pricing.
    # These are estimates — verify current rates at provider pricing pages.
    RATES: dict[str, tuple[float, float]] = {
        "gpt-4o-mini": (0.15e-6, 0.60e-6),        # (input $/tok, output $/tok)
        "claude-sonnet-4-6": (3.00e-6, 15.00e-6),
    }
    model = deps.model_name
    in_rate, out_rate = RATES.get(model, (0.0, 0.0))
    cost = (usage.input_tokens or 0) * in_rate + (usage.output_tokens or 0) * out_rate

    logger.info(
        "agent.run.cost",
        run_id=result.run_id,
        model=model,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cache_read_tokens=usage.cache_read_tokens,
        llm_requests=usage.requests,
        tool_calls=usage.tool_calls,
        estimated_cost_usd=round(cost, 6),
        cost_method="provider_reported_tokens_times_rate",
    )

    return result.output
```

**Token counting**: Provider-reported via Pydantic AI `RunUsage`. Values are exact for completed runs and zero for failed or aborted runs.

---

## What to Log / What Not to Log

### Log These

- **Tool invocations**: tool name, `run_id`, `retry`, `max_retries` — no parameter values unless sanitized
- **Tool results**: aggregate metrics (`reply_count`, `post_count`, `duration_ms`) — not content
- **Errors**: `error_type` (exception class name), `duration_ms`, stack trace with `exc_info=True` in file logs (safe because `show_locals=False`)
- **LLM costs**: `input_tokens`, `output_tokens`, `cache_read_tokens`, `llm_requests`, `tool_calls`, `estimated_cost_usd`, `cost_method`
- **Request context**: `run_id` bound at request entry via `CorrelationMiddleware`, propagated automatically

### Never Log These

- **User-generated content**: post text, message bodies, conversation history — can be gigabytes and contains verbatim user input
- **Identifiers that single out individuals**: user handles, DID strings — GDPR risk
- **Credentials**: API keys, bearer tokens, session cookies — `scrub_sensitive_fields` processor catches these as a last resort, but they should never reach it
- **Prompt content**: log `len(prompt)` or `hashlib.sha256(prompt.encode()).hexdigest()[:16]` if debugging requires a proxy identifier
- **Full stack traces with locals**: `show_locals=False` enforces this — never override it
- **IP addresses from third-party API responses** without verified consent documentation

---

## Example Log Output

```jsonl
{"event": "tool.called", "tool": "fetch_thread", "run_id": "run_8f3a2c", "retry": 0, "max_retries": 3, "uri_prefix": "at://did:plc:abc123/app.bsky.feed.post/3k", "level": "info", "timestamp": "2026-02-22T10:30:00.123456Z"}
{"event": "tool.completed", "tool": "fetch_thread", "run_id": "run_8f3a2c", "retry": 0, "reply_count": 47, "duration_ms": 1322.4, "level": "info", "timestamp": "2026-02-22T10:30:01.445891Z"}
{"event": "agent.run.cost", "run_id": "run_8f3a2c", "model": "gpt-4o-mini", "input_tokens": 1842, "output_tokens": 312, "cache_read_tokens": 0, "llm_requests": 2, "tool_calls": 1, "estimated_cost_usd": 0.000463, "cost_method": "provider_reported_tokens_times_rate", "level": "info", "timestamp": "2026-02-22T10:30:01.892341Z"}
```

---

## Query Cookbook

All queries assume JSONL format at `/var/log/myapp/app.jsonl`.

```bash
# All events for a specific agent run
jq 'select(.run_id == "YOUR_RUN_ID")' /var/log/myapp/app.jsonl

# All tool failures today
grep "$(date -u +%Y-%m-%dT%H)" /var/log/myapp/app.jsonl \
  | jq 'select(.event == "tool.failed")'

# Total estimated cost today
jq -s '[.[] | select(.event == "agent.run.cost") | .estimated_cost_usd // 0] | add' \
  /var/log/myapp/app.jsonl

# Runs costing more than $0.10
jq 'select(.event == "agent.run.cost" and .estimated_cost_usd > 0.10)' \
  /var/log/myapp/app.jsonl

# Tool failure rate by tool name
jq -s 'group_by(.tool) | map({
    tool: .[0].tool,
    errors: (map(select(.event == "tool.failed")) | length),
    total: length
  })' /var/log/myapp/app.jsonl

# P95 tool duration (requires duration_ms in all tool.completed events)
jq -s '[.[] | select(.event == "tool.completed" and .duration_ms != null) | .duration_ms] \
  | sort | .[(length * 0.95 | floor)]' /var/log/myapp/app.jsonl

# All rate limit hits
jq 'select(.event == "rate_limit.hit")' /var/log/myapp/app.jsonl

# Auth failures
jq 'select(.event == "auth.failure")' /var/log/myapp/app.jsonl
```

---

## Environment and Deployment

### Development vs Production

| Setting | Development | Production |
|---------|-------------|------------|
| `json_output` | `False` (ConsoleRenderer) | `True` (JSONL) |
| `log_level` | `"DEBUG"` | `"INFO"` |
| `log_path` | N/A (stdout) | `/var/log/myapp/app.jsonl` |
| `show_locals` | `False` (always) | `False` (always) |
| `scrub_sensitive_fields` | Enabled | Enabled |
| `cache_logger_on_first_use` | `True` | `True` |

```python
import os

configure_logging(
    log_level=os.getenv("LOG_LEVEL", "INFO"),
    json_output=os.getenv("ENV", "development") == "production",
    log_path=os.getenv("LOG_PATH", "/var/log/myapp/app.jsonl"),
)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | Minimum log level |
| `ENV` | `development` | Set to `production` for JSONL output |
| `LOG_PATH` | `/var/log/myapp/app.jsonl` | Log file path (production only) |

---

## Log Rotation and Retention

### In-process rotation (RotatingFileHandler)

```python
handler = logging.handlers.RotatingFileHandler(
    log_path,
    maxBytes=50 * 1024 * 1024,   # 50 MB per file
    backupCount=10,               # 10 files = 550 MB max on disk
    encoding="utf-8",
)
```

### Time-based retention via logrotate

```
# /etc/logrotate.d/myapp
/var/log/myapp/app.jsonl {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
}
```

**GDPR compliance**: GDPR Article 5(1)(e) requires that logs not be kept longer than necessary for their purpose. 30-day rolling retention is the recommended default. For legal holds, extend cold storage to 90 days.

> ⚠️ structlog has no built-in retention management. Log rotation and deletion are entirely the responsibility of the deployment environment. Ensure `logrotate` or an equivalent is configured before going to production.

---

## OpenTelemetry Migration Path

This is a 3-step migration. Steps 2 and 3 require no changes to any `logger.info()` / `logger.error()` call sites.

### Step 1: Current (pure structlog)

No changes needed — the configuration in this guide is Step 1.

### Step 2: Add Logfire bridge (no changes to logger call sites)

```bash
uv add "pydantic-ai[logfire]"
```

```python
import logfire
import structlog

logfire.configure()  # reads LOGFIRE_TOKEN env var

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="%Y-%m-%d %H:%M:%S", utc=False),
        logfire.StructlogProcessor(),   # Must precede final renderer
        scrub_sensitive_fields,
        structlog.dev.ConsoleRenderer(),
    ],
)

# Instrument all Pydantic AI agents — no per-tool code needed.
from pydantic_ai import Agent, InstrumentationSettings
Agent.instrument_all(InstrumentationSettings(include_content=False))
```

All existing `logger.info()` calls now appear in Logfire automatically.

**`include_content=False`**: Excludes prompt text, completion text, tool arguments, and tool return values from all telemetry. This provides stronger privacy than `scrub_sensitive_fields` post-hoc scrubbing because content is never serialized into span attributes in the first place. Mandatory for production Logfire deployment.

Source: [Logfire structlog integration docs](https://logfire.pydantic.dev/docs/integrations/structlog/)

### Step 3: Self-hosted OTel (no Logfire cloud)

```python
import os
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://otel-collector.internal:4318"
logfire.configure(send_to_logfire=False)
Agent.instrument_all(InstrumentationSettings(include_content=False))
# All spans go to your OTel Collector (Grafana Tempo, SigNoz, Jaeger, etc.)
```

### Step 3 (alternative): Bypass Logfire entirely with raw OTel SDK

```python
from opentelemetry.sdk.trace import TracerProvider
from pydantic_ai import Agent, InstrumentationSettings

Agent.instrument_all(InstrumentationSettings(include_content=False))
```

Use this when the Logfire dependency itself is undesirable (license constraints, supply-chain policy, etc.).

---

## Testing Logging Behavior

```python
# tests/test_logging.py
import pytest
import structlog.testing
from myapp.logging_config import scrub_sensitive_fields


def test_forbidden_fields_dropped():
    """scrub_sensitive_fields removes api_key unconditionally."""
    event_dict = {"event": "test", "api_key": "sk-abc123", "other": "value"}
    result = scrub_sensitive_fields(None, "info", event_dict)
    assert "api_key" not in result
    assert result["other"] == "value"


def test_api_key_in_string_drops_event():
    """Event with API key pattern in a string value raises DropEvent."""
    event_dict = {"event": "test", "message": "api_key=sk-abc123"}
    with pytest.raises(structlog.DropEvent):
        scrub_sensitive_fields(None, "info", event_dict)


def test_email_in_string_is_redacted():
    """Email addresses in string values are replaced, not dropped."""
    event_dict = {"event": "test", "detail": "sent to user@example.com"}
    result = scrub_sensitive_fields(None, "info", event_dict)
    assert "user@example.com" not in result["detail"]
    assert "[EMAIL REDACTED]" in result["detail"]


@pytest.mark.asyncio
async def test_tool_does_not_log_content(mock_ctx):
    """Verify tool logs do not include raw content or user-identifiable fields."""
    from myapp.tools import fetch_thread

    with structlog.testing.capture_logs() as logs:
        await fetch_thread(ctx=mock_ctx, thread_uri="at://did:plc:test/...")

    for entry in logs:
        assert "text" not in entry, f"Content field 'text' found in log: {entry}"
        assert "handle" not in entry, f"Identifying field 'handle' found in log: {entry}"
```

---

## References

- [structlog v25.5.0 documentation](https://www.structlog.org/en/stable/)
- [structlog Issue #715 — credential exposure via dict_tracebacks](https://github.com/hynek/structlog/issues/715)
- [Pydantic AI RunUsage API](https://ai.pydantic.dev/api/usage/)
- [Logfire structlog integration](https://logfire.pydantic.dev/docs/integrations/structlog/)
- [Better Stack — Safeguarding Sensitive Data in logs](https://betterstack.com/community/guides/logging/sensitive-data/)
- [OpenTelemetry GenAI span semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
