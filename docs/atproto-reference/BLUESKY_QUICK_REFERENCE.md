# Bluesky Thread Data Structure - Quick Reference

## Single Post Type

All Bluesky posts use: **`app.bsky.feed.post`**

```json
{
  "$type": "app.bsky.feed.post",
  "text": "Max 3000 chars, 300 graphemes",
  "createdAt": "2024-01-31T10:30:00.000Z",
  "reply": { /* optional */ },
  "embed": { /* optional */ },
  "facets": [ /* optional - mentions, URLs */ ],
  "languages": [ /* optional - max 3 */ ],
  "labels": [ /* optional - content warnings */ ],
  "tags": [ /* optional - hashtags, max 8 */ ]
}
```

## Three Post Node Types (in Thread Responses)

### 1. ThreadViewPost (Normal Post)
```json
{
  "$type": "app.bsky.feed.defs#threadViewPost",
  "post": {
    "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
    "author": { "did": "...", "handle": "user.bsky.social" },
    "record": { "text": "...", "createdAt": "..." },
    "likeCount": 42,
    "repostCount": 10,
    "replyCount": 5
  },
  "parent": { /* Optional - ancestor */ },
  "replies": [ /* Array of direct children */ ]
}
```

### 2. NotFoundPost (Deleted/Unavailable)
```json
{
  "$type": "app.bsky.feed.defs#notFoundPost",
  "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
  "notFound": true
}
```

### 3. BlockedPost (Blocked)
```json
{
  "$type": "app.bsky.feed.defs#blockedPost",
  "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
  "blocked": true,
  "author": { "viewer": { "blockedBy": true } }
}
```

## Replies vs Quotes

### Reply (Threaded)
- Uses `reply` field with both parent and root
- Creates hierarchical relationship
- Appears in thread tree

```json
{
  "$type": "app.bsky.feed.post",
  "text": "This is a reply",
  "reply": {
    "root": { "uri": "at://...", "cid": "..." },
    "parent": { "uri": "at://...", "cid": "..." }
  }
}
```

### Quote (Independent)
- Uses `embed.record` field (NOT `reply`)
- Does NOT create thread relationship
- Embeds the target post

```json
{
  "$type": "app.bsky.feed.post",
  "text": "This is a quote post",
  "embed": {
    "$type": "app.bsky.embed.record",
    "record": { "uri": "at://...", "cid": "..." }
  }
}
```

## Embed Types

| Type | $type | Max | Use |
|------|-------|-----|-----|
| Images | `app.bsky.embed.images` | 4 per post, 1MB each | Photos |
| Video | `app.bsky.embed.video` | 1 per post | Videos |
| External | `app.bsky.embed.external` | 1 per post | Links with preview |
| Record | `app.bsky.embed.record` | 1 per post | Quote posts |
| RecordWithMedia | `app.bsky.embed.recordWithMedia` | Quote + images/video | Quote with media |

## getPostThread API

**Endpoint**: `GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread`

**Parameters**:
- `uri`: AT-URI of post (required)
- `depth`: Reply depth to fetch, 0-1000 (default: 6)
- `parentHeight`: Ancestor depth to fetch, 0-1000 (default: 80)

**Response**:
```json
{
  "thread": { /* ThreadViewPost | NotFoundPost | BlockedPost */ },
  "threadgate": { /* optional */ }
}
```

## Thread Organization

```
Ancestors (nested tree)
  └─ Parent
      └─ Parent.parent
          └─ ...
              └─ Root Post
                  ├─ Reply 1 (direct child)
                  ├─ Reply 2 (direct child)
                  └─ [other direct children only - no nesting in array]
```

**Key Point**: `parent` is nested (parent.parent.parent...), but `replies` is a flat array (only direct children).

## Python: atproto SDK Installation

```bash
pip install atproto
```

## Python: Basic Thread Fetching

```python
from atproto import Client, models

client = Client()

# Fetch thread
response = client.app.bsky.feed.get_post_thread(
    uri="at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
    depth=100,
    parent_height=100
)

# Check node type
if isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
    post = response.thread.post
    print(f"Text: {post.record.text}")
    print(f"Author: {post.author.handle}")

elif isinstance(response.thread, models.AppBskyFeedDefs.NotFoundPost):
    print("Post not found")

elif isinstance(response.thread, models.AppBskyFeedDefs.BlockedPost):
    print("Post blocked")
```

## Python: Identify Post Type

```python
def categorize_post(post):
    is_reply = post.record.reply is not None
    is_quote = (
        post.record.embed and
        isinstance(post.record.embed, models.AppBskyEmbedRecord.Main)
    )
    return "reply" if is_reply else "quote" if is_quote else "standalone"
```

## Python: Identify Embed Type

```python
embed = post.record.embed

if isinstance(embed, models.AppBskyEmbedImages.Main):
    print(f"Images: {len(embed.images)} photos")

elif isinstance(embed, models.AppBskyEmbedExternal.Main):
    print(f"Link: {embed.external.uri}")

elif isinstance(embed, models.AppBskyEmbedRecord.Main):
    print(f"Quote post: {embed.record.uri}")

elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
    print("Quote post with media")
```

## TypeScript: Current Implementation (bsky-thread-fetcher)

Located in: `/Users/scott/projects/test/bsky-thread-fetcher/src/services/bluesky.ts`

- Direct API calls to Bluesky public endpoints
- Manual TypeScript types defined
- Supports getPostThread with depth/parentHeight
- Handles ThreadViewPost, NotFoundPost, BlockedPost
- Cloudflare Workers compatible

## Key Differences from JavaScript SDK

| Feature | atproto Python | JavaScript @atproto/api | TypeScript Manual |
|---------|----------------|------------------------|------------------|
| Auto-generated models | ✅ | ✅ | ❌ |
| Type validation | ✅ Pydantic | ✅ TypeScript | ❌ |
| Thread support | ✅ | ✅ | ✅ |
| Create posts | ✅ | ✅ | ❌ |
| DMs | ✅ | ✅ | ❌ |
| Firehose | ✅ | ✅ | ❌ |
| Maintenance | Active | Active | Manual |

## Reference Links

- **Bluesky Docs**: https://docs.bsky.app/
- **atproto SDK**: https://atproto.blue/
- **atproto GitHub**: https://github.com/MarshalX/atproto
- **AT Protocol**: https://atproto.com/
- **Lexicon: post.json**: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json
- **Lexicon: getPostThread.json**: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getPostThread.json

