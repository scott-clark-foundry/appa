# bsky-cli Reference Guide

Reference document for downstream projects building on what we learned in `bsky-cli/`.

---

## External References

### AT Protocol SDK (`atproto` Python package)

**Package**: `atproto>=0.0.55` — [PyPI](https://pypi.org/project/atproto/) · [GitHub](https://github.com/MarshalX/atproto)

**Key imports**:
```python
from atproto import Client, SessionEvent, models
```

#### Authentication

The SDK uses **app passwords** (not account passwords). Generate at: Settings → App Passwords on bsky.app.

Two login flows:
1. **Fresh login**: `client.login(handle, app_password)` — returns session, triggers `SessionEvent.CREATE`
2. **Session reuse**: `client.login(session_string=saved_string)` — restores prior session, triggers `SessionEvent.REFRESH` if token refreshed

Session persistence uses a callback:
```python
client.on_session_change(callback)  # callback(event: SessionEvent, session)
session.export()  # → string for disk storage
```

Session events: `SessionEvent.CREATE`, `SessionEvent.REFRESH`

Logout (server-side JWT invalidation): `client.com.atproto.server.delete_session()`

#### API Methods Used

| Method | Returns | Notes |
|--------|---------|-------|
| `client.me` | Authenticated user profile | Available after login |
| `client.get_profile(actor)` | `ProfileViewDetailed` | actor = handle or DID |
| `client.get_profiles(actors=[...])` | `GetProfilesResponse` | Batch, max 25 per call |
| `client.get_timeline(limit, cursor)` | `GetTimelineResponse` | Paginated, newest-first. `cursor` for next page. Max `limit=100` |
| `client.get_post_thread(uri, depth, parent_height)` | `GetPostThreadResponse` | `depth` = reply levels down (max 1000). `parent_height` = ancestor levels up |
| `client.follow(did)` | Follow record | Creates `app.bsky.graph.follow` record |
| `client.unfollow(follow_uri)` | None | Requires the AT URI of the follow record, not the DID |
| `client.app.bsky.notification.list_notifications(limit)` | `ListNotificationsResponse` | |
| `client.app.bsky.notification.get_unread_count()` | `GetUnreadCountResponse` | `.count` field |
| `client.app.bsky.notification.update_seen(data)` | None | Pass `Data(seen_at=iso_timestamp)` |

#### Data Model Types

All under `models.AppBskyFeedDefs` or `models.AppBskyEmbedX`:

| Type | Where it appears | Key fields |
|------|-----------------|------------|
| `FeedViewPost` | Timeline items | `.post`, `.reply`, `.reason` |
| `PostView` | The actual post | `.author`, `.record`, `.embed`, `.like_count`, `.reply_count`, `.repost_count`, `.uri`, `.indexed_at`, `.labels` |
| `ThreadViewPost` | Thread responses | `.post`, `.parent`, `.replies` (list of ThreadViewPost) |
| `ReasonRepost` | `FeedViewPost.reason` | `.by` (who reposted) |
| Notification | From list_notifications | `.reason` (like/repost/follow/mention/reply/quote), `.author`, `.is_read`, `.indexed_at` |

#### Embed Types (py_type strings)

These are the `py_type` field values on `PostView.embed`:

| py_type contains | Embed type | Fields |
|------------------|-----------|--------|
| `images#view` | Image(s) | `.images[]` — each has `.alt`, `.fullsize`, `.thumb` |
| `video#view` | Video | `.alt`, `.playlist` (HLS URL), `.thumbnail` |
| `external#view` | Link card | `.external.title`, `.external.uri`, `.external.description` |
| `record#view` | Quote post | `.record` → `ViewRecord` with `.author`, `.value.text` |
| `recordWithMedia#view` | Quote + media | `.media` (images/video/external view) + `.record.record` (ViewRecord) |

**Gotcha**: For `record#view`, `embed.record` IS the ViewRecord. For `recordWithMedia#view`, it's `embed.record.record` (extra wrapper level).

**Gotcha**: Deleted/blocked quotes have `ViewDetached` — check `hasattr(record, 'value') and record.value is not None` before accessing.

#### AT URIs

Format: `at://{did}/{collection}/{rkey}`

Example: `at://did:plc:abc123/app.bsky.feed.post/3abc456`

Used for: fetching threads, identifying posts, follow/unfollow records.

#### Pagination Pattern

```python
cursor = None
while True:
    response = client.get_timeline(limit=100, cursor=cursor)
    if not response.feed:
        break
    for item in response.feed:
        process(item)
    cursor = response.cursor
```

Timeline returns newest-first. No `cursor` field on last page.

### Typer CLI Framework

**Package**: `typer[all]>=0.12` — includes Rich integration for `--help` formatting.

**Pattern used**: Single `app = typer.Typer()` with `@app.command()` decorators. Argument/option types via `typer.Argument()` and `typer.Option()`. `typer.Exit(1)` for non-zero exits.

### Rich Console

**Package**: Included via `typer[all]`.

Markup used: `[bold cyan]`, `[dim]`, `[green]`, `[red]`, `[yellow]`. `Rich.json.JSON` for pretty-printing raw API responses. `Rich.text.Text` for unstyled embed summaries (prevents Rich markup injection from user content).

### structlog

**Package**: `structlog>=24.0`

Configured as filtering bound logger at INFO level. Used for operational logging (`log.info("command_name", key=value)`), not user-facing output. User output goes through Rich console.

### Pydantic

**Package**: `pydantic>=2.0`

Used for config validation (`BskyUser`, `AppConfig` models). The atproto SDK also uses Pydantic internally — all response objects have `.model_dump()`, `.model_dump_json()`, `.model_validate()`.

### psycopg2

**Package**: `psycopg2-binary>=2.9`

Simple DSN connection. Used in bsky-cli for DB access but not central to the CLI workflow. The downstream ingest project is where DB integration matters.

---

## Internal Code Reference

### File: `bsky_run.py` (1255 lines)

Single-file PEP 723 script. Run with `uv run bsky_run.py <command>`.

#### Authentication Layer (lines 47–137)

| Symbol | Type | Purpose |
|--------|------|---------|
| `BskyUser` | Pydantic model | `handle`, `password`, `default` fields |
| `AppConfig` | Pydantic model | `.users` list + `.load()` classmethod |
| `AppConfig.load()` | classmethod | Priority: TOML file → env vars → empty. Supports multi-user TOML or single-user `BSKY_HANDLE`/`BSKY_APP_PASSWORD` |
| `_session_path(handle)` | function | `~/.cache/bsky_explorer/{slug}/session` — slug replaces `.` and `-` with `_` |
| `bsky_client(handle=None)` | function | **Main entry point.** Returns authenticated `Client`. Auto-selects user when: 1 user configured, or `default=true` in multi-user config. Reuses cached session or does fresh login. |
| `bsky_clients()` | function | Returns `{handle: Client}` dict for all configured users |

#### Post Analysis (lines 139–420)

| Symbol | Type | Purpose |
|--------|------|---------|
| `is_reply(item)` | function | `item.reply is not None` |
| `is_repost(item)` | function | `isinstance(item.reason, ReasonRepost)` |
| `format_counts(post)` | function | `["N likes", "M replies"]` — only non-zero |
| `format_embed(embed)` | function | One-line embed summary. Handles all 5 embed types + recordWithMedia combos. Returns `None` for no embed. |
| `classify_shape(post)` | function | Returns one of 17 bucket strings. Priority: labels → long_text → embed type. Thread-structural buckets (deeply_nested, wide_replies, thread_chain) assigned at harvest time, not here. |
| `_post_root_uri(item)` | function | Thread root URI: `record.reply.root.uri` for replies, `post.uri` for standalone |
| `group_feed_items(items)` | function | Groups consecutive timeline items by same root URI + same author. Each group sorted oldest-first. Used for collapsed thread display. |
| `max_reply_depth(node)` | function | Recursive. 0 = leaf, 1 = has direct replies, etc. |
| `count_root_replies(node)` | function | `len(node.replies)` |
| `_is_thread_chain(node)` | function | True if OP self-replies ≥3 times consecutively down the tree |

#### CLI Commands (lines 423–1254)

| Command | Line | Key behavior |
|---------|------|-------------|
| `whoami` | 427 | Prints `client.me.handle` |
| `login` | 434 | Forces fresh session |
| `logout` | 441 | Server-side JWT invalidation + local session file deletion |
| `timeline` | 539 | Fetches 1.7× requested limit to account for filtering. Filters replies/reposts client-side. Groups self-reply threads. Supports `--fixture` for offline mode. |
| `thread` | 680 | Walks ancestors via `.parent` chain, prints oldest-first, then root + replies recursively |
| `notifications` | 724 | Icons: ♥ like, ↩ repost, + follow, @ mention, ↪ reply, ❝ quote. Supports `--unread-only` and `--mark-read`. |
| `follow` | 600 | Idempotent: checks `profile.viewer.following` before acting |
| `unfollow` | 616 | Idempotent: needs `profile.viewer.following` URI to delete the follow record |
| `harvest_fixtures` | 756 | Pages timeline (up to 10 pages / ~1000 posts). For each post, fetches full thread and classifies into 17 buckets. Supports `--as all` for multi-user harvest. Auto-chains to profile harvest + timeline build. |
| `refresh_fixtures` | 1201 | Re-fetches every fixture by URI to update CDN URLs and engagement counts |
| `harvest_profiles` | 1238 | Extracts all DIDs from fixture tree (recursive), batch-fetches in groups of 25 |

#### Fixture System (lines 756–1198)

| Symbol | Type | Purpose |
|--------|------|---------|
| `_do_harvest_for_user()` | function | Core harvest loop. Loads/updates index, pages timeline, classifies posts, fills buckets up to target. |
| `_save_fixture()` | function | Serializes ThreadViewPost to JSON, appends to index with metadata (bucket, uri, has_replies, max_depth, like_count, collected_at) |
| `_extract_dids_from_fixtures()` | function | Walks all fixture JSON files recursively, extracts author DIDs from posts and all reply levels |
| `_harvest_profiles()` | function | Fetches profiles for DIDs not yet in profiles/index.json. Batches of 25. |
| `_build_timeline()` | function | Wraps all fixture root posts in FeedViewPost-shaped dicts → `fixtures/timeline.json` |
| `_print_fixture_stats()` | function | Summary table: count per bucket, % with replies, depth/engagement stats |
| `_migrate_multi_image_entries()` | function | One-time migration from old `multi_image` bucket to `2_images`/`3_images`/`4_images` |

**17 fixture buckets**: `no_embed`, `single_image`, `2_images`, `3_images`, `4_images`, `video`, `external`, `quote`, `quote_unavailable`, `rwm_images`, `rwm_video`, `rwm_external`, `labeled`, `long_text`, `deeply_nested`, `wide_replies`, `thread_chain`

#### Display Functions (lines 452–677)

| Symbol | Type | Purpose |
|--------|------|---------|
| `_print_timeline_group()` | function | Renders single posts or collapsed thread groups. Single: `[N] @handle ts` + text + embed + counts. Thread: header + first post + "N more" + last post. |
| `_print_thread()` | function | Recursive tree renderer. Root: no prefix. Replies: `└─` with increasing indent. |

### Config Files

| File | Purpose |
|------|---------|
| `bsky_config.toml` | Multi-user credentials (TOML `[[users]]` array). See `bsky_config.example.toml`. |
| `.env` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Optional: `BSKY_CONFIG_FILE`, `BSKY_SESSION_FILE`, `BSKY_HANDLE`, `BSKY_APP_PASSWORD`. |
| `compose.yml` | pgvector PostgreSQL 16 + Adminer (port 8080) |
| `pyproject.toml` | pytest + ruff config only (not for dependency installation — PEP 723 handles that) |

### Test Files

| File | What it covers |
|------|---------------|
| `tests/conftest.py` | Fixtures: `mock_env`, `captured_console`, `fixture_server`. Helpers: `make_post_ns()`, `make_thread_node()`, `make_feed_post()` for building fake atproto objects. |
| `tests/test_unit.py` | Config loading, user selection logic, format_counts, format_embed (all embed types), classify_shape (all 17 buckets), group_feed_items, thread depth/width/chain detection, fixture saving, timeline building. ~600 lines. |
| `tests/test_integration.py` | Live API: follow/unfollow lifecycle, whoami. Requires `BSKY_HANDLE`/`BSKY_APP_PASSWORD` env vars. Marker: `@pytest.mark.integration`. |
| `tests/test_user.py` | CLI subprocess tests: help output, bad command exit code, flag acceptance. No credentials needed. Marker: `@pytest.mark.user`. |
| `tests/test_fixture_server.py` | HTTP fixture server that serves JSON files for frontend integration tests. |

---

## Patterns Worth Reusing

### Session Caching
Cache session strings to disk at `~/.cache/{app}/{user_slug}/session`. Avoids re-authentication on every CLI invocation. The `on_session_change` callback handles both initial login and token refresh transparently.

### Idempotent Social Actions
Check `profile.viewer.following` before follow/unfollow. The follow URI (not the target DID) is needed for unfollow — it's the AT URI of the `app.bsky.graph.follow` record.

### Timeline Overfetch
Request ~1.7× the desired count to compensate for client-side filtering of replies and reposts. The API doesn't support server-side filtering for these.

### Embed Type Dispatch
Use `py_type` string matching (`"images#view" in py_type`) rather than `isinstance` checks. More reliable across SDK versions and handles the nested recordWithMedia case cleanly.

### Fixture Harvesting for Frontend Dev
Collect real API responses categorized by shape/structure, build a fake timeline from them, and serve via a local fixture server. Gives realistic test data without hitting live APIs during development.

### Multi-User Config
TOML `[[users]]` array with `default = true` marker. Backward-compatible with single-user env vars. `--as handle` flag on every command for explicit selection.
