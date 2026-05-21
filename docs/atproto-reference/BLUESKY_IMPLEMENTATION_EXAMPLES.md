# Bluesky Thread Parsing - Implementation Examples

Complete code examples for parsing Bluesky threads using the atproto Python SDK.

## Installation

```bash
pip install atproto
```

---

## Example 1: Basic Thread Fetching and Display

```python
from atproto import Client, models
from typing import Optional

def fetch_and_display_thread(thread_uri: str, depth: int = 100, parent_height: int = 100) -> None:
    """Fetch a thread and display it in a readable format."""

    client = Client()

    # Fetch the thread
    response = client.app.bsky.feed.get_post_thread(
        uri=thread_uri,
        depth=depth,
        parent_height=parent_height
    )

    # Display the thread
    if isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
        print("=" * 80)
        print("THREAD FOUND")
        print("=" * 80)

        # Display ancestors if any
        if response.thread.parent:
            print("\nANCESTORS:")
            display_ancestors(response.thread.parent, indent=0)

        # Display root post
        print("\nROOT POST:")
        display_post(response.thread.post, indent=0, is_root=True)

        # Display replies
        if response.thread.replies:
            print(f"\nREPLIES ({len(response.thread.replies)} direct):")
            for reply in response.thread.replies:
                display_post_node(reply, indent=1)

    elif isinstance(response.thread, models.AppBskyFeedDefs.NotFoundPost):
        print(f"Post not found: {response.thread.uri}")

    elif isinstance(response.thread, models.AppBskyFeedDefs.BlockedPost):
        print(f"Post blocked: {response.thread.uri}")


def display_ancestors(node: models.AppBskyFeedDefs.ThreadViewPost, indent: int) -> None:
    """Recursively display ancestor posts."""

    if isinstance(node, models.AppBskyFeedDefs.ThreadViewPost):
        display_post(node.post, indent=indent)

        if node.parent:
            print("\n" + " " * (indent * 2) + "↑ [parent]")
            display_ancestors(node.parent, indent + 1)


def display_post(post: models.AppBskyFeedPost.PostView, indent: int = 0, is_root: bool = False) -> None:
    """Display a single post with formatting."""

    indent_str = "  " * indent
    marker = "→ " if not is_root else ""

    print(f"{indent_str}{marker}@{post.author.handle} ({post.author.display_name or 'No name'})")
    print(f"{indent_str}  {post.record.text}")
    print(f"{indent_str}  ❤️ {post.like_count} | 🔄 {post.repost_count} | 💬 {post.reply_count}")

    if post.record.embed:
        embed_info = describe_embed(post.record.embed)
        print(f"{indent_str}  📎 {embed_info}")


def display_post_node(node, indent: int = 1) -> None:
    """Display a post node, handling all three types."""

    indent_str = "  " * indent

    if isinstance(node, models.AppBskyFeedDefs.ThreadViewPost):
        display_post(node.post, indent=indent)

        if node.replies:
            print(f"{indent_str}└─ {len(node.replies)} replies")
            for reply in node.replies[:3]:  # Show first 3
                display_post_node(reply, indent + 1)
            if len(node.replies) > 3:
                print(f"{'  ' * (indent + 1)}... and {len(node.replies) - 3} more")

    elif isinstance(node, models.AppBskyFeedDefs.NotFoundPost):
        print(f"{indent_str}[Not found: {node.uri}]")

    elif isinstance(node, models.AppBskyFeedDefs.BlockedPost):
        print(f"{indent_str}[Blocked]")


def describe_embed(embed) -> str:
    """Describe an embed in human-readable format."""

    if isinstance(embed, models.AppBskyEmbedImages.Main):
        return f"📷 {len(embed.images)} image(s)"

    elif isinstance(embed, models.AppBskyEmbedVideo.Main):
        return "🎥 Video"

    elif isinstance(embed, models.AppBskyEmbedExternal.Main):
        return f"🔗 Link: {embed.external.title or embed.external.uri}"

    elif isinstance(embed, models.AppBskyEmbedRecord.Main):
        return "🔗 Quote post"

    elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
        return "🔗 Quote post with media"

    return "📎 Embed"


# Usage
if __name__ == "__main__":
    thread_uri = "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g"
    fetch_and_display_thread(thread_uri)
```

---

## Example 2: Extract Structured Thread Data

```python
from dataclasses import dataclass
from typing import Optional, List
from datetime import datetime
from atproto import Client, models


@dataclass
class Author:
    did: str
    handle: str
    display_name: Optional[str]
    avatar: Optional[str]

    @classmethod
    def from_raw(cls, author: models.AppBskyActorDefs.ProfileViewBasic) -> "Author":
        return cls(
            did=author.did,
            handle=author.handle,
            display_name=author.display_name,
            avatar=author.avatar
        )


@dataclass
class Post:
    uri: str
    author: Author
    text: str
    created_at: datetime
    likes: int
    reposts: int
    replies_count: int
    embed_type: Optional[str]

    @classmethod
    def from_raw(cls, post: models.AppBskyFeedPost.PostView) -> "Post":
        return cls(
            uri=post.uri,
            author=Author.from_raw(post.author),
            text=post.record.text,
            created_at=post.record.created_at,
            likes=post.like_count or 0,
            reposts=post.repost_count or 0,
            replies_count=post.reply_count or 0,
            embed_type=get_embed_type(post.record.embed)
        )


@dataclass
class ThreadNode:
    post: Optional[Post]
    status: str  # "visible", "not_found", "blocked"
    uri: str
    replies: List["ThreadNode"]

    def count_total_posts(self) -> int:
        """Count all posts in subtree."""
        count = 1 if self.status == "visible" else 0
        for reply in self.replies:
            count += reply.count_total_posts()
        return count

    def get_max_depth(self) -> int:
        """Get maximum depth from this node."""
        if not self.replies:
            return 0
        return 1 + max((r.get_max_depth() for r in self.replies), default=0)


@dataclass
class ThreadData:
    root: ThreadNode
    ancestors: List[Post]
    total_posts: int
    max_depth_from_root: int
    original_uri: str


def get_embed_type(embed) -> Optional[str]:
    """Get embed type as string."""

    if embed is None:
        return None
    elif isinstance(embed, models.AppBskyEmbedImages.Main):
        return "images"
    elif isinstance(embed, models.AppBskyEmbedVideo.Main):
        return "video"
    elif isinstance(embed, models.AppBskyEmbedExternal.Main):
        return "external_link"
    elif isinstance(embed, models.AppBskyEmbedRecord.Main):
        return "quote_post"
    elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
        return "quote_with_media"
    return "unknown"


def parse_thread_node(node) -> ThreadNode:
    """Recursively parse a thread node."""

    if isinstance(node, models.AppBskyFeedDefs.ThreadViewPost):
        post = Post.from_raw(node.post)

        # Parse replies
        replies = []
        if node.replies:
            for reply in node.replies:
                replies.append(parse_thread_node(reply))

        return ThreadNode(
            post=post,
            status="visible",
            uri=node.post.uri,
            replies=replies
        )

    elif isinstance(node, models.AppBskyFeedDefs.NotFoundPost):
        return ThreadNode(
            post=None,
            status="not_found",
            uri=node.uri,
            replies=[]
        )

    elif isinstance(node, models.AppBskyFeedDefs.BlockedPost):
        return ThreadNode(
            post=None,
            status="blocked",
            uri=node.uri,
            replies=[]
        )


def parse_ancestors(node: Optional[models.AppBskyFeedDefs.ThreadViewPost]) -> List[Post]:
    """Recursively extract ancestor chain."""

    ancestors = []

    if node and isinstance(node, models.AppBskyFeedDefs.ThreadViewPost):
        ancestors.append(Post.from_raw(node.post))

        if node.parent:
            ancestors.extend(parse_ancestors(node.parent))

    return ancestors


def extract_thread_data(thread_uri: str) -> ThreadData:
    """Extract complete thread data as structured objects."""

    client = Client()
    response = client.app.bsky.feed.get_post_thread(
        uri=thread_uri,
        depth=100,
        parent_height=100
    )

    if not isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
        raise ValueError("Root must be ThreadViewPost")

    # Parse root and replies
    root_node = parse_thread_node(response.thread)

    # Parse ancestors
    ancestors = parse_ancestors(response.thread.parent)

    return ThreadData(
        root=root_node,
        ancestors=ancestors,
        total_posts=root_node.count_total_posts() + len(ancestors),
        max_depth_from_root=root_node.get_max_depth(),
        original_uri=thread_uri
    )


# Usage
if __name__ == "__main__":
    thread_uri = "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g"
    data = extract_thread_data(thread_uri)

    print(f"Total posts: {data.total_posts}")
    print(f"Max depth: {data.max_depth_from_root}")
    print(f"Ancestors: {len(data.ancestors)}")
    print(f"Root post by: {data.root.post.author.handle}")
```

---

## Example 3: Categorize Posts and Identify Relationships

```python
from enum import Enum
from typing import Dict, Any
from atproto import Client, models


class PostType(Enum):
    STANDALONE = "standalone"
    REPLY = "reply"
    QUOTE = "quote"
    QUOTE_WITH_MEDIA = "quote_with_media"


class EmbedType(Enum):
    NONE = "none"
    IMAGES = "images"
    VIDEO = "video"
    EXTERNAL_LINK = "external_link"
    QUOTE = "quote"
    QUOTE_WITH_MEDIA = "quote_with_media"
    UNKNOWN = "unknown"


def categorize_post(post: models.AppBskyFeedPost.PostView) -> Dict[str, Any]:
    """Analyze a post and categorize its type and content."""

    # Determine post type
    is_reply = post.record.reply is not None
    embed = post.record.embed

    is_quote = False
    is_quote_with_media = False

    if embed:
        if isinstance(embed, models.AppBskyEmbedRecord.Main):
            is_quote = True
        elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
            is_quote_with_media = True

    # Determine post type
    if is_reply:
        post_type = PostType.REPLY
    elif is_quote_with_media:
        post_type = PostType.QUOTE_WITH_MEDIA
    elif is_quote:
        post_type = PostType.QUOTE
    else:
        post_type = PostType.STANDALONE

    # Determine embed type
    embed_type = get_detailed_embed_info(embed)

    return {
        "post_type": post_type.value,
        "embed_type": embed_type["type"],
        "embed_details": embed_type.get("details"),
        "has_mentions": has_mentions(post.record.facets),
        "has_links": has_links(post.record.facets),
        "languages": post.record.languages or [],
        "is_reply": is_reply,
        "is_quote": is_quote,
        "parent_uri": post.record.reply.parent.uri if is_reply else None,
        "root_uri": post.record.reply.root.uri if is_reply else None,
        "quoted_uri": (
            embed.record.uri if isinstance(embed, models.AppBskyEmbedRecord.Main)
            else embed.record.record.uri if isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main)
            else None
        )
    }


def get_detailed_embed_info(embed) -> Dict[str, Any]:
    """Get detailed information about an embed."""

    if embed is None:
        return {"type": "none"}

    elif isinstance(embed, models.AppBskyEmbedImages.Main):
        return {
            "type": "images",
            "details": {
                "count": len(embed.images),
                "images": [
                    {
                        "alt": img.alt or "",
                        "mime_type": img.image.mime_type
                    }
                    for img in embed.images
                ]
            }
        }

    elif isinstance(embed, models.AppBskyEmbedVideo.Main):
        return {
            "type": "video",
            "details": {
                "duration": embed.video.get("duration") if hasattr(embed.video, 'get') else None
            }
        }

    elif isinstance(embed, models.AppBskyEmbedExternal.Main):
        return {
            "type": "external_link",
            "details": {
                "uri": embed.external.uri,
                "title": embed.external.title,
                "description": embed.external.description,
                "has_thumbnail": embed.external.thumb is not None
            }
        }

    elif isinstance(embed, models.AppBskyEmbedRecord.Main):
        return {
            "type": "quote_post",
            "details": {
                "quoted_uri": embed.record.uri,
                "quoted_cid": embed.record.cid
            }
        }

    elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
        media_type = (
            "images" if isinstance(embed.media, models.AppBskyEmbedImages.Main)
            else "video" if isinstance(embed.media, models.AppBskyEmbedVideo.Main)
            else "unknown"
        )
        return {
            "type": "quote_with_media",
            "details": {
                "quoted_uri": embed.record.record.uri,
                "media_type": media_type
            }
        }

    return {"type": "unknown"}


def has_mentions(facets) -> bool:
    """Check if post has mentions."""
    if not facets:
        return False
    return any(
        f.features and any(
            isinstance(feat, models.AppBskyRichtextFacet.Mention)
            for feat in f.features
        )
        for f in facets
    )


def has_links(facets) -> bool:
    """Check if post has links."""
    if not facets:
        return False
    return any(
        f.features and any(
            isinstance(feat, models.AppBskyRichtextFacet.Link)
            for feat in f.features
        )
        for f in facets
    )


def analyze_thread_composition(thread_uri: str) -> Dict[str, Any]:
    """Analyze the composition of a thread."""

    client = Client()
    response = client.app.bsky.feed.get_post_thread(
        uri=thread_uri,
        depth=100,
        parent_height=100
    )

    if not isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
        raise ValueError("Root must be ThreadViewPost")

    stats = {
        "total_posts": 0,
        "replies": 0,
        "quotes": 0,
        "with_images": 0,
        "with_links": 0,
        "with_mentions": 0,
        "post_types": {"reply": 0, "quote": 0, "quote_with_media": 0, "standalone": 0}
    }

    def analyze_node(node):
        if isinstance(node, models.AppBskyFeedDefs.ThreadViewPost):
            stats["total_posts"] += 1
            analysis = categorize_post(node.post)
            stats["post_types"][analysis["post_type"]] += 1

            if analysis["is_reply"]:
                stats["replies"] += 1
            if analysis["is_quote"]:
                stats["quotes"] += 1
            if analysis["embed_type"] == "images":
                stats["with_images"] += 1
            if analysis["has_links"]:
                stats["with_links"] += 1
            if analysis["has_mentions"]:
                stats["with_mentions"] += 1

            if node.replies:
                for reply in node.replies:
                    analyze_node(reply)

    analyze_node(response.thread)

    return stats


# Usage
if __name__ == "__main__":
    thread_uri = "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g"
    stats = analyze_thread_composition(thread_uri)

    print(f"Total posts: {stats['total_posts']}")
    print(f"Replies: {stats['replies']}")
    print(f"Quotes: {stats['quotes']}")
    print(f"With images: {stats['with_images']}")
    print(f"Post type breakdown: {stats['post_types']}")
```

---

## Example 4: Export Thread to JSON

```python
import json
from datetime import datetime
from typing import Any, Dict, List
from atproto import Client, models


def post_to_dict(post: models.AppBskyFeedPost.PostView) -> Dict[str, Any]:
    """Convert a post to a dictionary."""

    return {
        "uri": post.uri,
        "cid": post.cid,
        "author": {
            "did": post.author.did,
            "handle": post.author.handle,
            "displayName": post.author.display_name,
            "avatar": post.author.avatar,
        },
        "text": post.record.text,
        "createdAt": post.record.created_at.isoformat(),
        "indexedAt": post.indexed_at.isoformat() if hasattr(post, 'indexed_at') else None,
        "likeCount": post.like_count or 0,
        "repostCount": post.repost_count or 0,
        "replyCount": post.reply_count or 0,
        "embed": embed_to_dict(post.record.embed),
        "languages": post.record.languages or [],
    }


def embed_to_dict(embed) -> Dict[str, Any] | None:
    """Convert an embed to a dictionary."""

    if embed is None:
        return None

    result = {"$type": "unknown"}

    if isinstance(embed, models.AppBskyEmbedImages.Main):
        result = {
            "$type": "app.bsky.embed.images",
            "images": [
                {
                    "alt": img.alt or "",
                    "image": {
                        "mimeType": img.image.mime_type,
                        "size": img.image.size,
                        "link": img.image.link
                    }
                }
                for img in embed.images
            ]
        }

    elif isinstance(embed, models.AppBskyEmbedExternal.Main):
        result = {
            "$type": "app.bsky.embed.external",
            "external": {
                "uri": embed.external.uri,
                "title": embed.external.title,
                "description": embed.external.description or "",
                "thumb": str(embed.external.thumb) if embed.external.thumb else None
            }
        }

    elif isinstance(embed, models.AppBskyEmbedRecord.Main):
        result = {
            "$type": "app.bsky.embed.record",
            "record": {
                "uri": embed.record.uri,
                "cid": embed.record.cid
            }
        }

    elif isinstance(embed, models.AppBskyEmbedRecordWithMedia.Main):
        result = {
            "$type": "app.bsky.embed.recordWithMedia",
            "record": {
                "uri": embed.record.record.uri,
                "cid": embed.record.record.cid
            },
            "media": embed_to_dict(embed.media)
        }

    return result


def node_to_dict(node) -> Dict[str, Any]:
    """Convert a thread node to a dictionary."""

    if isinstance(node, models.AppBskyFeedDefs.ThreadViewPost):
        return {
            "$type": "app.bsky.feed.defs#threadViewPost",
            "post": post_to_dict(node.post),
            "parent": node_to_dict(node.parent) if node.parent else None,
            "replies": [node_to_dict(reply) for reply in node.replies] if node.replies else []
        }

    elif isinstance(node, models.AppBskyFeedDefs.NotFoundPost):
        return {
            "$type": "app.bsky.feed.defs#notFoundPost",
            "uri": node.uri,
            "notFound": True
        }

    elif isinstance(node, models.AppBskyFeedDefs.BlockedPost):
        return {
            "$type": "app.bsky.feed.defs#blockedPost",
            "uri": node.uri,
            "blocked": True
        }


def export_thread_to_json(thread_uri: str, output_file: str) -> None:
    """Fetch a thread and export it to JSON."""

    client = Client()
    response = client.app.bsky.feed.get_post_thread(
        uri=thread_uri,
        depth=100,
        parent_height=100
    )

    thread_data = {
        "thread": node_to_dict(response.thread),
        "threadgate": None,  # Add if available
        "metadata": {
            "fetchedAt": datetime.now().isoformat(),
            "originalUri": thread_uri
        }
    }

    with open(output_file, "w") as f:
        json.dump(thread_data, f, indent=2)

    print(f"Thread exported to {output_file}")


# Usage
if __name__ == "__main__":
    thread_uri = "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g"
    export_thread_to_json(thread_uri, "thread_export.json")
```

---

## Example 5: Error Handling and Retry Logic

```python
import time
from typing import Optional
from atproto import Client, models
from atproto.exceptions import AtprotoError


class ThreadFetchError(Exception):
    """Base exception for thread fetching errors."""
    pass


class ThreadNotFoundError(ThreadFetchError):
    """Thread does not exist."""
    pass


class ThreadRateLimitedError(ThreadFetchError):
    """Rate limited by Bluesky API."""
    pass


class ThreadBlockedError(ThreadFetchError):
    """Thread is blocked."""
    pass


def fetch_thread_with_retry(
    thread_uri: str,
    max_retries: int = 3,
    backoff_factor: float = 2.0,
    depth: int = 100,
    parent_height: int = 100
) -> models.AppBskyFeedDefs.ThreadViewPost:
    """Fetch a thread with automatic retry and exponential backoff."""

    client = Client()
    last_error = None

    for attempt in range(max_retries):
        try:
            response = client.app.bsky.feed.get_post_thread(
                uri=thread_uri,
                depth=depth,
                parent_height=parent_height
            )

            if isinstance(response.thread, models.AppBskyFeedDefs.NotFoundPost):
                raise ThreadNotFoundError(f"Thread not found: {thread_uri}")

            if isinstance(response.thread, models.AppBskyFeedDefs.BlockedPost):
                raise ThreadBlockedError(f"Thread is blocked: {thread_uri}")

            if isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
                return response.thread

            raise ThreadFetchError("Unexpected thread response type")

        except ThreadNotFoundError as e:
            # Don't retry for not found
            raise e

        except ThreadBlockedError as e:
            # Don't retry for blocked
            raise e

        except AtprotoError as e:
            last_error = e

            # Check for rate limiting
            if e.response.status == 429:
                if attempt < max_retries - 1:
                    wait_time = backoff_factor ** attempt
                    print(f"Rate limited. Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                    continue
                raise ThreadRateLimitedError(f"Rate limited after {max_retries} attempts")

            # Other errors
            if attempt < max_retries - 1:
                wait_time = backoff_factor ** attempt
                print(f"Error (attempt {attempt + 1}/{max_retries}): {str(e)}")
                print(f"Retrying in {wait_time}s...")
                time.sleep(wait_time)
                continue

            raise

        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                wait_time = backoff_factor ** attempt
                print(f"Unexpected error: {str(e)}")
                print(f"Retrying in {wait_time}s...")
                time.sleep(wait_time)
                continue
            raise

    # Should not reach here
    raise ThreadFetchError(f"Failed to fetch thread after {max_retries} attempts") from last_error


def safe_fetch_thread(
    thread_uri: str,
    max_retries: int = 3
) -> Optional[models.AppBskyFeedDefs.ThreadViewPost]:
    """Safely fetch a thread, returning None on failure."""

    try:
        return fetch_thread_with_retry(thread_uri, max_retries=max_retries)
    except ThreadFetchError as e:
        print(f"Failed to fetch thread: {e}")
        return None


# Usage
if __name__ == "__main__":
    thread_uri = "at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g"

    try:
        thread = fetch_thread_with_retry(thread_uri)
        print(f"Thread fetched: {thread.post.uri}")
    except ThreadNotFoundError as e:
        print(f"Thread not found: {e}")
    except ThreadRateLimitedError as e:
        print(f"Rate limited: {e}")
    except ThreadBlockedError as e:
        print(f"Thread blocked: {e}")
    except ThreadFetchError as e:
        print(f"Error fetching thread: {e}")
```

---

## References

- [atproto Python SDK Documentation](https://atproto.blue/)
- [Bluesky API Documentation](https://docs.bsky.app/)
- [AT Protocol Specification](https://atproto.com/)

