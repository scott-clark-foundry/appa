# Bluesky Thread Data Structures and Python Libraries Research

## Executive Summary

This document provides a comprehensive analysis of Bluesky thread data structures, the JSON formats used by the ATProto API, and available Python libraries for parsing and handling Bluesky thread data.

**Recommended Solution**: The **atproto** Python SDK (by MarshalX) is the best choice for production Bluesky thread parsing because it:
- Automatically generates type-safe models from ATProto lexicons
- Provides both sync and async support
- Uses Pydantic for robust data validation
- Supports comprehensive thread operations with proper parent-child relationships
- Is actively maintained and widely used in the community

---

## Part 1: Bluesky Thread Data Structures

### 1.1 Thread Overview

A **thread** in Bluesky refers to a collection of posts consisting of:
- **Root post**: The original post that started the thread
- **Replies (descendants)**: All direct and nested replies to posts in the thread
- **Parents (ancestors)**: All posts that the root post is replying to (the conversation chain above)

### 1.2 Post Types

Bluesky has a single post record type: `app.bsky.feed.post`

All posts follow this structure:

```json
{
  "$type": "app.bsky.feed.post",
  "text": "Post content (max 3000 chars, 300 graphemes)",
  "createdAt": "2024-01-31T10:30:00.000Z"
}
```

#### Optional Post Fields

| Field | Type | Purpose |
|-------|------|---------|
| `embed` | Embed (union) | Rich media content (images, videos, links, records) |
| `reply` | ReplyRef | Makes this post a reply; contains parent and root refs |
| `facets` | Array | Rich-text annotations (mentions, URLs, hashtags) |
| `languages` | Array | Languages in the post (max 3 items) |
| `labels` | Array | Self-applied content warnings |
| `tags` | Array | Hashtags (max 8 items) |

### 1.3 Reply Structure

When a post is a **reply**, it contains a `reply` field with both parent and root references:

```json
{
  "$type": "app.bsky.feed.post",
  "text": "This is a reply",
  "createdAt": "2024-01-31T10:31:00.000Z",
  "reply": {
    "root": {
      "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
      "cid": "bafyreiecx6dujwoeqpdzl27w67z4h46hyklk3an4i4cvvmioaqb2qbyo5u"
    },
    "parent": {
      "uri": "at://did:plc:yyy/app.bsky.feed.post/3k44deefqdk2h",
      "cid": "bafyreiecx6dujwoeqpdzl27w67z4h46hyklk3an4i4cvvmioaqb2qbyo5v"
    }
  }
}
```

**Key Point**: Both parent and root references are always required for replies. This dual-reference system allows the system to reconstruct complete conversation threads.

### 1.4 Embed Types

Posts can include embeds using an "open union" type that supports:

| Embed Type | $type | Purpose | Example Use |
|-----------|-------|---------|------------|
| Images | `app.bsky.embed.images` | Up to 4 images per post (max 1MB each) | Sharing photos |
| Video | `app.bsky.embed.video` | Video embedding | Sharing videos |
| External | `app.bsky.embed.external` | Website preview cards (title, desc, thumbnail) | Sharing links |
| Record | `app.bsky.embed.record` | Embedding another post (quote post) | Commenting on existing post |
| RecordWithMedia | `app.bsky.embed.recordWithMedia` | Quote post + images or video | Quote with media |

#### Quote Post Example

```json
{
  "$type": "app.bsky.feed.post",
  "text": "This is a great post!",
  "createdAt": "2024-01-31T10:32:00.000Z",
  "embed": {
    "$type": "app.bsky.embed.record",
    "record": {
      "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
      "cid": "bafyreiecx6dujwoeqpdzl27w67z4h46hyklk3an4i4cvvmioaqb2qbyo5u"
    }
  }
}
```

**Important Distinction**: Quote posts embed the referenced post as an object, NOT creating a threaded connection. They're independent posts that reference others, unlike replies which create hierarchical relationships.

### 1.5 Key Differences Between Post Types

| Type | Structure | Use Case | Parent/Child |
|------|-----------|----------|--------------|
| **Root Post** | Text + optional embeds | Starting a conversation | No parent |
| **Reply** | Text + optional embeds + `reply` field | Responding in thread | Has parent + root |
| **Quote Post** | Text + `embed.record` (not `reply` field) | Commenting independently | No parent, embeds target |

---

## Part 2: Bluesky API JSON Response Format

### 2.1 getPostThread Response Structure

The `app.bsky.feed.getPostThread` endpoint returns a thread by its AT-URI:

**Endpoint**: `GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread`

**Parameters**:
- `uri` (required): AT-URI of the post (e.g., `at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g`)
- `depth` (optional): Reply depth to fetch; range 0-1000, default 6
- `parentHeight` (optional): Ancestor depth to fetch; range 0-1000, default 80

**Response Structure**:

```json
{
  "thread": {
    // One of: ThreadViewPost, NotFoundPost, or BlockedPost
  },
  "threadgate": {
    // Optional threadgate information
  }
}
```

### 2.2 ThreadViewPost Structure

The primary post type returned in thread responses:

```json
{
  "$type": "app.bsky.feed.defs#threadViewPost",
  "post": {
    "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
    "cid": "bafyreiecx6dujwoeqpdzl27w67z4h46hyklk3an4i4cvvmioaqb2qbyo5u",
    "author": {
      "did": "did:plc:xxx",
      "handle": "user.bsky.social",
      "displayName": "User Display Name",
      "avatar": "https://cdn.bsky.app/..."
    },
    "record": {
      "text": "Post content",
      "createdAt": "2024-01-31T10:30:00.000Z",
      "reply": {
        // Optional reply reference
      },
      "embed": {
        // Optional embed
      }
    },
    "indexedAt": "2024-01-31T10:30:00.000Z",
    "likeCount": 42,
    "repostCount": 10,
    "replyCount": 5
  },
  "parent": {
    // Optional: Can be ThreadViewPost, NotFoundPost, or BlockedPost
    // Represents the immediate parent post (for nested threads)
  },
  "replies": [
    // One-dimensional array of replies (direct children only)
    // Each item can be ThreadViewPost, NotFoundPost, or BlockedPost
  ]
}
```

### 2.3 NotFoundPost Structure

Returned when a post in the thread is deleted or unavailable:

```json
{
  "$type": "app.bsky.feed.defs#notFoundPost",
  "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
  "notFound": true
}
```

### 2.4 BlockedPost Structure

Returned when a post is blocked or the user is blocked:

```json
{
  "$type": "app.bsky.feed.defs#blockedPost",
  "uri": "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
  "blocked": true,
  "author": {
    "did": "did:plc:xxx",
    "viewer": {
      "blockedBy": true
    }
  }
}
```

### 2.5 Thread Reconstruction Logic

The API response structure is designed for efficient client-side reconstruction:

1. **Parent chain**: Organized as a nested tree (parent contains parent.parent)
2. **Replies**: Flat array containing only direct children
3. **Tree building**: Client traverses parent chain upward and replies array downward

```
Example thread with depth=2, parentHeight=1:

Parent (ancestor)          <- parent field (nested)
  └─ Root Post            <- thread object
       ├─ Reply 1         <- replies[0]
       ├─ Reply 2         <- replies[1]
       │   └─ Reply 2.1   <- NOT in replies array (depth limited)
```

---

## Part 3: Available Python Libraries

### 3.1 Recommended: atproto SDK

**Repository**: [MarshalX/atproto](https://github.com/MarshalX/atproto)
**PyPI**: `pip install atproto`
**Documentation**: [atproto.blue](https://atproto.blue/)

#### Key Features

✅ **Automatic Code Generation**: All models, queries, and procedures are auto-generated from ATProto lexicons
✅ **Type Safety**: Full TypeScript-style type hints with Pydantic validation
✅ **Dual API**: Both synchronous and asynchronous clients with identical signatures
✅ **Comprehensive Models**: Complete models for all post types, embeds, and thread structures
✅ **Rich Ecosystem**: Support for firehose, identity resolution, XRPC, DAG-CBOR, CAR files
✅ **Active Maintenance**: Regularly updated to support new ATProto features
✅ **Community Adoption**: Widely used in production applications

#### Core Models for Threads

```python
from atproto import Client, models

# Client provides high-level API
client = Client()

# For thread retrieval
response = client.app.bsky.feed.get_post_thread(
    uri="at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
    depth=100,
    parent_height=100
)

# Response includes:
# - response.thread: Can be ThreadViewPost, NotFoundPost, or BlockedPost
# - models.AppBskyFeedDefs.ThreadViewPost
# - models.AppBskyFeedDefs.NotFoundPost
# - models.AppBskyFeedDefs.BlockedPost
```

#### Model Structure

All models are nested under `models.AppBsky*` namespaces:

```python
# Post-related models
models.AppBskyFeedPost.Record          # Post record for creation
models.AppBskyFeedDefs.ThreadViewPost  # Thread node with parent/replies
models.AppBskyFeedDefs.PostView        # Post with engagement metrics

# Embed models
models.AppBskyEmbedImages.Main        # Image embed
models.AppBskyEmbedExternal.Main      # External link embed
models.AppBskyEmbedRecord.Main        # Record (quote) embed
models.AppBskyEmbedRecordWithMedia.Main  # Quote + media embed

# Reply structure
models.ComAtprotoRepoStrongRef         # Strong reference (uri + cid)
```

#### Advantages for Thread Parsing

1. **Parent-Child Tracking**: Built-in models properly represent:
   - `post.parent` (nested structure for ancestors)
   - `post.replies` (flat array of direct children)

2. **Type Discrimination**: Helper functions identify post type:
   ```python
   if isinstance(node.thread, models.AppBskyFeedDefs.ThreadViewPost):
       # Valid post with content
   elif isinstance(node.thread, models.AppBskyFeedDefs.NotFoundPost):
       # Deleted or unavailable post
   elif isinstance(node.thread, models.AppBskyFeedDefs.BlockedPost):
       # Blocked post
   ```

3. **Embed Handling**: Strongly typed embed unions:
   ```python
   post = node.thread.post
   if post.embed and isinstance(post.embed, models.AppBskyEmbedRecord.Main):
       # Quote post - access quoted_post_uri
   elif post.embed and isinstance(post.embed, models.AppBskyEmbedImages.Main):
       # Image post - access images
   ```

4. **Automatic Validation**: Pydantic automatically validates:
   - Required fields presence
   - Type correctness
   - Enum values
   - Complex nested structures

### 3.2 Alternative: Official Bluesky JavaScript SDK (@atproto/api)

**Repository**: [bluesky-social/atproto](https://github.com/bluesky-social/atproto)
**NPM**: `@atproto/api`

**Note**: While the codebase uses this (TypeScript/Workers), it's primarily for JavaScript/TypeScript environments. The JavaScript SDK is more mature for browser/Node.js use cases.

### 3.3 Other Python Options

| Library | Status | Notes |
|---------|--------|-------|
| **psychonaut** | Experimental | Async Pydantic models, not stable |
| **atproto-tools** | Early stage | Specialized tools, limited scope |
| **pyatproto** | Early stage | Community fork, limited adoption |

**Recommendation**: These alternative libraries are not recommended for production use due to limited maintenance and community adoption compared to the official atproto SDK.

### 3.4 Why NOT Other Approaches

**❌ Raw HTTP + Manual Parsing**:
- Error-prone type handling
- Must manually validate all fields
- No IDE autocompletion support
- Brittle with API changes

**❌ Building from CAR Files**:
- Unnecessary complexity for thread retrieval
- Rate limiting concerns from individual post fetches
- Recommended only for special use cases (archival, migration)

**✅ Use getPostThread API + atproto SDK**:
- Single API call retrieves entire thread
- Automatic model validation
- Full type safety
- Efficient and maintainable

---

## Part 4: How atproto Handles Thread Hierarchies

### 4.1 Tree Traversal Pattern

The atproto SDK preserves Bluesky's response structure:

```python
from atproto import Client, models

client = Client()
response = client.app.bsky.feed.get_post_thread(uri=thread_uri)

def traverse_thread(node):
    """Recursively traverse thread tree."""

    if isinstance(node.thread, models.AppBskyFeedDefs.ThreadViewPost):
        post = node.thread.post

        # Process ancestors (parents)
        if node.thread.parent:
            traverse_thread(node.thread.parent)

        # Process current post
        print(f"Post: {post.record.text}")
        print(f"Author: {post.author.handle}")
        print(f"Depth: {depth}")

        # Process descendants (replies)
        if node.thread.replies:
            for reply in node.thread.replies:
                traverse_thread(reply)

    elif isinstance(node.thread, models.AppBskyFeedDefs.NotFoundPost):
        print(f"Post not found: {node.thread.uri}")

    elif isinstance(node.thread, models.AppBskyFeedDefs.BlockedPost):
        print(f"Post blocked: {node.thread.uri}")

traverse_thread(response)
```

### 4.2 Extracting Thread Metadata

```python
def extract_thread_info(response, original_uri):
    """Extract structured thread information."""

    thread = response.thread

    if not isinstance(thread, models.AppBskyFeedDefs.ThreadViewPost):
        raise ValueError("Root must be ThreadViewPost")

    root_post = thread.post

    return {
        "root": {
            "uri": root_post.uri,
            "author": {
                "did": root_post.author.did,
                "handle": root_post.author.handle,
                "displayName": root_post.author.display_name,
            },
            "text": root_post.record.text,
            "createdAt": root_post.record.created_at,
            "stats": {
                "likes": root_post.like_count,
                "reposts": root_post.repost_count,
                "replies": root_post.reply_count,
            }
        },
        "replies": extract_replies(thread.replies) if thread.replies else [],
        "ancestors": extract_ancestors(thread.parent) if thread.parent else [],
    }

def extract_replies(replies_array):
    """Recursively extract replies from flat array."""
    result = []
    for reply_node in replies_array:
        if isinstance(reply_node, models.AppBskyFeedDefs.ThreadViewPost):
            post = reply_node.post
            result.append({
                "uri": post.uri,
                "author": post.author.handle,
                "text": post.record.text,
                "replies": extract_replies(reply_node.replies) if reply_node.replies else [],
            })
    return result

def extract_ancestors(parent_node):
    """Recursively extract ancestor chain."""
    if not parent_node:
        return []

    result = []
    if isinstance(parent_node, models.AppBskyFeedDefs.ThreadViewPost):
        post = parent_node.post
        result.append({
            "uri": post.uri,
            "author": post.author.handle,
            "text": post.record.text,
        })
        if parent_node.parent:
            result.extend(extract_ancestors(parent_node.parent))
    return result
```

### 4.3 Handling Different Post States

```python
def process_post(post_node):
    """Handle all three possible post states."""

    if isinstance(post_node, models.AppBskyFeedDefs.ThreadViewPost):
        # Valid, accessible post
        return {
            "status": "visible",
            "content": post_node.post.record.text,
            "author": post_node.post.author.handle,
        }

    elif isinstance(post_node, models.AppBskyFeedDefs.NotFoundPost):
        # Deleted or missing post
        return {
            "status": "not_found",
            "uri": post_node.uri,
            "reason": "Post deleted or unavailable",
        }

    elif isinstance(post_node, models.AppBskyFeedDefs.BlockedPost):
        # Blocked by user or blocking current user
        return {
            "status": "blocked",
            "uri": post_node.uri,
            "blocked_by": post_node.author.viewer.blocked_by if post_node.author.viewer else False,
        }
```

---

## Part 5: Comparison with Current TypeScript Implementation

The project currently uses a TypeScript implementation (in `bsky-thread-fetcher/`). Here's how the current approach compares to the atproto Python SDK:

### Current TypeScript Implementation

**File**: `/Users/scott/projects/test/bsky-thread-fetcher/src/services/bluesky.ts`

**Features**:
- ✅ Direct API calls to Bluesky public endpoints
- ✅ Manual TypeScript type definitions for thread response
- ✅ Recursive thread normalization
- ✅ Depth tracking and statistics gathering
- ✅ Error handling for rate limits and invalid threads

**Types Defined**:
```typescript
interface RawThreadViewPost {
  $type: 'app.bsky.feed.defs#threadViewPost';
  post: RawPost;
  parent?: RawThreadViewPost | RawNotFoundPost | RawBlockedPost;
  replies?: Array<RawThreadViewPost | RawNotFoundPost | RawBlockedPost>;
}

interface RawNotFoundPost {
  $type: 'app.bsky.feed.defs#notFoundPost';
  uri: string;
  notFound: true;
}

interface RawBlockedPost {
  $type: 'app.bsky.feed.defs#blockedPost';
  uri: string;
  blocked: true;
}
```

**Advantages vs. atproto SDK**:
1. More lightweight for simple thread fetching
2. Direct control over HTTP calls and Cloudflare Workers constraints
3. Clearer separation of concerns for the specific use case

**Disadvantages vs. atproto SDK**:
1. Must manually maintain type definitions
2. No validation of API responses
3. Limited to thread operations (can't create posts, reply, etc.)
4. Doesn't track future API changes automatically

---

## Part 6: Recommendations

### 6.1 For Python Development

**Use**: **atproto Python SDK** ([MarshalX/atproto](https://github.com/MarshalX/atproto))

**Installation**:
```bash
pip install atproto
```

**Why**:
- Comprehensive, auto-generated models for all post types
- Type-safe with Pydantic validation
- Handles all edge cases (NotFoundPost, BlockedPost)
- Actively maintained by community
- Excellent documentation and examples
- Supports future Bluesky API expansion automatically

**Best For**:
- Thread analysis and parsing
- Building Bluesky bots and tools
- Creating posts, replies, and embeds
- Direct messaging
- Full-featured Bluesky applications

### 6.2 For JavaScript/TypeScript Development

**Continue using**: Current TypeScript approach in `bsky-thread-fetcher/`

Or migrate to: **@atproto/api** SDK for more features

**Why**:
- Already implemented and working
- Cloudflare Workers compatible
- Lightweight for simple thread operations
- Direct API control valuable for Workers environment

### 6.3 Integration Pattern

If you need Python for backend processing while maintaining the TypeScript frontend/API layer:

```python
# Python backend service
from atproto import Client, models
import json

def fetch_and_process_thread(thread_uri: str) -> dict:
    """Fetch and process thread using atproto SDK."""

    client = Client()
    response = client.app.bsky.feed.get_post_thread(
        uri=thread_uri,
        depth=100,
        parent_height=100
    )

    # Process and return data matching your schema
    return normalize_thread_response(response)

# Can be called from Cloudflare Workers via API calls
```

---

## Part 7: Data Structure Summary Table

| Aspect | Detail |
|--------|--------|
| **Single Post Type** | `app.bsky.feed.post` |
| **Thread Node Types** | ThreadViewPost, NotFoundPost, BlockedPost |
| **Reply Structure** | Requires both `parent` and `root` references |
| **Quote vs Reply** | Quote uses embed, reply uses reply field |
| **Embed Types** | images, video, external, record, recordWithMedia |
| **Parent Organization** | Nested tree (parent contains parent.parent) |
| **Replies Organization** | Flat array of direct children |
| **Max Text Length** | 3000 chars, 300 graphemes |
| **Max Images** | 4 per post, 1MB each |
| **Facets** | Rich-text annotations (mentions, URLs, etc) |
| **Optional Fields** | embed, reply, facets, languages, labels, tags |

---

## Part 8: Code Examples

### 8.1 Basic Thread Fetching with atproto

```python
from atproto import Client, models

# Initialize client (no auth needed for public posts)
client = Client()

# Fetch thread
uri = "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g"
response = client.app.bsky.feed.get_post_thread(
    uri=uri,
    depth=100,
    parent_height=100
)

# Access root post
if isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
    post = response.thread.post
    print(f"Author: {post.author.handle}")
    print(f"Text: {post.record.text}")
    print(f"Likes: {post.like_count}")
    print(f"Replies: {post.reply_count}")
```

### 8.2 Processing All Post States

```python
def safe_get_post_text(post_node) -> str:
    """Safely extract text from any post node type."""

    if isinstance(post_node, models.AppBskyFeedDefs.ThreadViewPost):
        return post_node.post.record.text
    elif isinstance(post_node, models.AppBskyFeedDefs.NotFoundPost):
        return "[Post not found]"
    elif isinstance(post_node, models.AppBskyFeedDefs.BlockedPost):
        return "[Post blocked]"
    else:
        return "[Unknown post type]"
```

### 8.3 Identifying Embed Types

```python
def analyze_embeds(post):
    """Identify and process different embed types."""

    if not post.record.embed:
        return {"type": "none"}

    embed = post.record.embed

    if isinstance(embed, models.AppBskyEmbedImages.Main):
        return {
            "type": "images",
            "count": len(embed.images),
            "images": [
                {
                    "alt": img.alt,
                    "blob_ref": img.image.link
                }
                for img in embed.images
            ]
        }

    elif isinstance(embed, models.AppBskyEmbedExternal.Main):
        return {
            "type": "external",
            "url": embed.external.uri,
            "title": embed.external.title,
            "description": embed.external.description,
        }

    elif isinstance(embed, models.AppBskyEmbedRecord.Main):
        return {
            "type": "quote_post",
            "quoted_uri": embed.record.uri,
            "quoted_cid": embed.record.cid,
        }

    elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
        return {
            "type": "quote_with_media",
            "quoted_uri": embed.record.record.uri,
            "media_type": "images" if embed.media and isinstance(embed.media, models.AppBskyEmbedImages.Main) else "video",
        }

    return {"type": "unknown"}
```

### 8.4 Identifying Reply vs Quote Post

```python
def categorize_post(post):
    """Determine if post is a reply, quote, or standalone."""

    is_reply = post.record.reply is not None
    is_quote = (
        post.record.embed and
        isinstance(post.record.embed,
                  (models.AppBskyEmbedRecord.Main,
                   models.AppBskyEmbedRecordWithMedia.Main))
    )

    return {
        "is_reply": is_reply,
        "is_quote": is_quote,
        "type": (
            "reply" if is_reply else
            "quote" if is_quote else
            "standalone"
        ),
        "parent_uri": post.record.reply.parent.uri if is_reply else None,
        "root_uri": post.record.reply.root.uri if is_reply else None,
    }
```

---

## References

### Official Bluesky Documentation
- [Creating a post | Bluesky](https://docs.bsky.app/docs/tutorials/creating-a-post)
- [Posts | Bluesky](https://docs.bsky.app/docs/advanced-guides/posts)
- [Viewing threads | Bluesky](https://docs.bsky.app/docs/tutorials/viewing-threads)
- [oEmbed and Post Embed Widget | Bluesky](https://docs.bsky.app/docs/advanced-guides/oembed)

### ATProto Specification
- [The AT Protocol | Bluesky](https://docs.bsky.app/docs/advanced-guides/atproto)
- [AT Protocol](https://atproto.com/)
- [ATProto Lexicon: app.bsky.feed.post](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json)
- [ATProto Lexicon: getPostThread](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getPostThread.json)

### Python SDKs
- [atproto Python SDK | PyPI](https://pypi.org/project/atproto/)
- [atproto SDK | GitHub](https://github.com/MarshalX/atproto)
- [The AT Protocol SDK | Documentation](https://atproto.blue/)
- [ATProto SDK Python | Testing](https://www.msleigh.io/blog/2024/11/13/testing-the-python-sdk-for-blueskys-at-protocol/)

### Implementation Examples
- [Exploring AT Protocol with Python | David Gasquez](https://davidgasquez.com/exploring-atproto-python/)
- [Posting into BlueSky, Nostr and Threads from Python | bentasker](https://www.bentasker.co.uk/posts/blog/software-development/automatically-posting-into-bsky-threads-and-nostr-from-python.html)
- [How to post links on Bluesky with the atproto Python library | tweedge's blog](https://chris.partridge.tech/notes/post-link-on-bluesky-atproto-python/)
- [Bluesky API Integration Complete Guide | Ayrshare](https://www.ayrshare.com/complete-guide-to-bluesky-api-integration-authorization-posting-analytics-comments/)

### Community Resources
- [ATProto Ecosystem | Bluesky Social](https://github.com/bluesky-social/atproto-ecosystem)
- [SDKs - AT Protocol](https://atproto.com/sdks)
- [GitHub Discussion: Threading support](https://github.com/bluesky-social/atproto/discussions/2321)
- [GitHub Discussion: Building threads from CAR](https://github.com/bluesky-social/atproto/discussions/2368)

---

## Document Information

**Created**: 2026-01-31
**Research Scope**: Bluesky thread data structures, ATProto API response formats, Python library evaluation
**Status**: Complete research document
**Recommendation**: Adopt **atproto Python SDK** for all production Python-based Bluesky thread parsing needs

