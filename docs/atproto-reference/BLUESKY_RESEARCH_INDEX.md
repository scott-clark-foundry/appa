# Bluesky Thread Research - Document Index

## Overview

Complete research on Bluesky thread data structures, JSON API responses, and Python libraries for thread parsing. All documents are in `/Users/scott/projects/test/`.

---

## Documents Created

### 1. BLUESKY_RESEARCH.md (28 KB, 795 lines)
**Comprehensive Research Document**

Deep dive into all aspects of Bluesky thread handling.

**Contents:**
- Part 1: Bluesky Thread Data Structures
  - Thread overview and components
  - Post types and structures
  - Reply structure (parent + root references)
  - All 5 embed types explained
  - Post type comparisons

- Part 2: Bluesky API JSON Response Format
  - getPostThread endpoint specifications
  - ThreadViewPost structure (complete schema)
  - NotFoundPost structure
  - BlockedPost structure
  - Thread reconstruction logic

- Part 3: Available Python Libraries
  - Recommended: atproto SDK (comprehensive)
  - Alternative options (not recommended)
  - Why NOT other approaches

- Part 4: How atproto Handles Thread Hierarchies
  - Tree traversal patterns
  - Thread metadata extraction
  - Handling different post states

- Part 5: Comparison with Current TypeScript Implementation
  - Analysis of bsky-thread-fetcher
  - Advantages and disadvantages

- Part 6: Recommendations
  - Python development guidance
  - JavaScript/TypeScript guidance
  - Integration patterns

- Part 7: Data Structure Summary Table
- Part 8: Code Examples

**Best For:** Understanding the full picture, architectural decisions, deep technical knowledge

---

### 2. BLUESKY_QUICK_REFERENCE.md (6 KB, 228 lines)
**Quick Lookup Guide**

One-page reference for developers.

**Contents:**
- Single post type definition
- Three post node types (ThreadViewPost, NotFoundPost, BlockedPost)
- Reply vs Quote comparison
- All 5 embed types in table format
- getPostThread API parameters
- Thread organization diagram
- Python SDK installation and basic usage
- Post type identification code
- Embed type identification code
- TypeScript implementation location
- SDK comparison table
- Quick reference links

**Best For:** Quick lookups while coding, side-by-side comparisons, essential information

---

### 3. BLUESKY_IMPLEMENTATION_EXAMPLES.md (24 KB, 843 lines)
**Production-Ready Code Examples**

Five complete, tested examples for common tasks.

**Example 1: Basic Thread Fetching and Display**
- Fetch and display thread structure
- Show ancestors and replies
- Pretty-print with engagement metrics
- Handle all post node types

**Example 2: Extract Structured Thread Data**
- Define domain models (Author, Post, ThreadNode, ThreadData)
- Recursive data extraction
- Count total posts and depth
- Type-safe data structures

**Example 3: Categorize Posts and Identify Relationships**
- Identify post types (reply, quote, standalone)
- Identify embed types (images, video, external, quote, quote+media)
- Detect mentions and links
- Analyze thread composition

**Example 4: Export Thread to JSON**
- Convert posts to dictionaries
- Handle embeds of all types
- Preserve full post metadata
- Export to JSON file

**Example 5: Error Handling and Retry Logic**
- Custom exception hierarchy
- Retry with exponential backoff
- Rate limit handling (429 responses)
- Safe fallback patterns

**Best For:** Copy-paste starting points, complete working code, production patterns

---

### 4. BLUESKY_RESEARCH_SUMMARY.txt (16 KB, 358 lines)
**Executive Summary and Navigation Guide**

High-level overview and quick navigation.

**Contents:**
- Deliverables overview
- Key findings summary
- Thread data structures at a glance
- API response format summary
- Python libraries overview
- Thread hierarchy examples
- Implementation recommendations
- Data extraction patterns
- How to use these documents
- Testing checklist
- Next steps timeline
- Troubleshooting guide
- Performance notes
- Final recommendations

**Best For:** Getting oriented, project planning, quick decisions

---

## Quick Navigation

### I want to...

**...understand Bluesky thread structures**
→ Read: BLUESKY_RESEARCH.md Parts 1-2

**...know which Python library to use**
→ Read: BLUESKY_RESEARCH.md Part 3
→ Or: BLUESKY_QUICK_REFERENCE.md (SDK comparison table)

**...see JSON schemas and API format**
→ Read: BLUESKY_RESEARCH.md Part 2
→ Or: BLUESKY_QUICK_REFERENCE.md (JSON examples)

**...start coding immediately**
→ Read: BLUESKY_IMPLEMENTATION_EXAMPLES.md (Examples 1-2)

**...handle errors and rate limiting**
→ Read: BLUESKY_IMPLEMENTATION_EXAMPLES.md (Example 5)

**...identify post and embed types**
→ Read: BLUESKY_IMPLEMENTATION_EXAMPLES.md (Example 3)

**...export thread data to JSON**
→ Read: BLUESKY_IMPLEMENTATION_EXAMPLES.md (Example 4)

**...make a quick decision**
→ Read: BLUESKY_RESEARCH_SUMMARY.txt (Recommendations section)

**...get oriented**
→ Read: BLUESKY_RESEARCH_SUMMARY.txt (all sections)

---

## Key Findings Summary

### Thread Data Structures
- **Single post type**: `app.bsky.feed.post`
- **Three thread node types**: ThreadViewPost, NotFoundPost, BlockedPost
- **Reply structure**: Requires both `parent` and `root` references
- **Quote posts**: Use `embed.record`, not `reply` field
- **Five embed types**: images, video, external, record, recordWithMedia

### Python Library Recommendation
- **Best choice**: **atproto SDK** (MarshalX/atproto)
- **Installation**: `pip install atproto`
- **Why**: Auto-generated models, Pydantic validation, full type safety, comprehensive features
- **Alternatives**: Not recommended (psychonaut, atproto-tools are immature)

### API Endpoint
```
GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread
Parameters:
  - uri (required): AT-URI of post
  - depth (0-1000, default 6): Reply depth
  - parentHeight (0-1000, default 80): Ancestor depth
```

### Current Implementation
- **Location**: `/Users/scott/projects/test/bsky-thread-fetcher/src/services/bluesky.ts`
- **Approach**: TypeScript, manual types, Cloudflare Workers compatible
- **Use case**: Simple thread fetching
- **Limitation**: Not suitable for extended Bluesky operations

### Recommendation
Use **Python + atproto** for backend processing while maintaining current TypeScript frontend.

---

## Installation & Setup

### Install atproto SDK
```bash
pip install atproto
```

### Basic Usage
```python
from atproto import Client, models

client = Client()
response = client.app.bsky.feed.get_post_thread(
    uri="at://did:plc:xxx/app.bsky.feed.post/3k44deefqdk2g",
    depth=100,
    parent_height=100
)

# Access root post
if isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
    post = response.thread.post
    print(f"Author: {post.author.handle}")
    print(f"Text: {post.record.text}")
```

---

## Document Statistics

| Document | Size | Lines | Purpose |
|----------|------|-------|---------|
| BLUESKY_RESEARCH.md | 28 KB | 795 | Comprehensive reference |
| BLUESKY_QUICK_REFERENCE.md | 6 KB | 228 | Quick lookup |
| BLUESKY_IMPLEMENTATION_EXAMPLES.md | 24 KB | 843 | Code examples |
| BLUESKY_RESEARCH_SUMMARY.txt | 16 KB | 358 | Executive summary |
| **TOTAL** | **74 KB** | **2,224** | Complete documentation |

---

## How to Read These Documents

### For Quick Understanding (5 minutes)
1. Read: BLUESKY_QUICK_REFERENCE.md
2. Skim: BLUESKY_RESEARCH_SUMMARY.txt

### For Implementation (1-2 hours)
1. Read: BLUESKY_QUICK_REFERENCE.md
2. Read: BLUESKY_IMPLEMENTATION_EXAMPLES.md (Examples 1-3)
3. Reference: BLUESKY_RESEARCH.md as needed

### For Complete Knowledge (3-4 hours)
1. Read: BLUESKY_QUICK_REFERENCE.md
2. Read: BLUESKY_RESEARCH.md (all parts)
3. Study: BLUESKY_IMPLEMENTATION_EXAMPLES.md (all examples)
4. Reference: BLUESKY_RESEARCH_SUMMARY.txt for checklist

### For Maintenance/Troubleshooting
1. Lookup: BLUESKY_QUICK_REFERENCE.md
2. Example: BLUESKY_IMPLEMENTATION_EXAMPLES.md
3. Troubleshoot: BLUESKY_RESEARCH_SUMMARY.txt (Troubleshooting section)

---

## Key Code Patterns

### Identify Post Type
```python
if isinstance(response.thread, models.AppBskyFeedDefs.ThreadViewPost):
    # Valid post
elif isinstance(response.thread, models.AppBskyFeedDefs.NotFoundPost):
    # Deleted/unavailable
elif isinstance(response.thread, models.AppBskyFeedDefs.BlockedPost):
    # Blocked
```

### Identify Embed Type
```python
if isinstance(embed, models.AppBskyEmbedImages.Main):
    # Images
elif isinstance(embed, models.AppBskyEmbedRecord.Main):
    # Quote post
# ... etc for all 5 types
```

### Identify Reply vs Quote
```python
is_reply = post.record.reply is not None
is_quote = isinstance(post.record.embed, models.AppBskyEmbedRecord.Main)
```

### Traverse Thread
```python
# Ancestors (nested)
current = response.thread.parent
while current:
    # process current
    current = current.parent

# Replies (flat array)
for reply in response.thread.replies:
    # process reply
```

---

## External References

### Official Documentation
- [Bluesky API Docs](https://docs.bsky.app/)
- [AT Protocol Specification](https://atproto.com/)
- [atproto SDK Documentation](https://atproto.blue/)

### GitHub Repositories
- [atproto Python SDK](https://github.com/MarshalX/atproto)
- [ATProto Official](https://github.com/bluesky-social/atproto)
- [Bluesky Social App](https://github.com/bluesky-social/social-app)

### Community Resources
- [ATProto Ecosystem](https://github.com/bluesky-social/atproto-ecosystem)
- [Exploring ATProto with Python](https://davidgasquez.com/exploring-atproto-python/)
- [Complete Bluesky API Guide](https://www.ayrshare.com/complete-guide-to-bluesky-api-integration-authorization-posting-analytics-comments/)

---

## Checklist for Implementation

- [ ] Read BLUESKY_QUICK_REFERENCE.md
- [ ] Install atproto: `pip install atproto`
- [ ] Test Example 1 (basic fetching)
- [ ] Test Example 2 (data extraction)
- [ ] Implement Example 3 (post categorization)
- [ ] Implement Example 5 (error handling)
- [ ] Add type hints and Pydantic models
- [ ] Implement retry logic for rate limiting
- [ ] Test with various thread structures
- [ ] Set up monitoring and logging
- [ ] Deploy to production

---

## Questions & Answers

**Q: What's the difference between reply and quote?**
A: Reply creates a threaded relationship (needs parent+root refs). Quote embeds the post (no thread relationship).

**Q: How do I traverse the thread tree?**
A: `parent` field is nested (recursive), `replies` field is flat array (iterate). See BLUESKY_IMPLEMENTATION_EXAMPLES.md Example 2.

**Q: What do I do with NotFoundPost and BlockedPost?**
A: Handle them separately. See BLUESKY_IMPLEMENTATION_EXAMPLES.md Example 3 for pattern.

**Q: How do I handle rate limiting?**
A: Implement exponential backoff. See BLUESKY_IMPLEMENTATION_EXAMPLES.md Example 5.

**Q: Should I use atproto or manual HTTP calls?**
A: Use atproto. It's more robust, type-safe, and maintained. See BLUESKY_RESEARCH.md Part 3.

**Q: How do I add Python backend while keeping TypeScript frontend?**
A: Use bsky-thread-fetcher (TypeScript) for API, create Python service for processing. See BLUESKY_RESEARCH.md Part 6.

---

## Maintenance & Updates

This research is current as of **January 31, 2026**.

Bluesky API is actively developed. Check for updates:
- Official docs: https://docs.bsky.app/
- atproto releases: https://github.com/MarshalX/atproto/releases
- Breaking changes: Follow official announcements

---

## Contact & Resources

For questions about implementations:
- Review BLUESKY_IMPLEMENTATION_EXAMPLES.md (has working code)
- Check BLUESKY_RESEARCH.md (comprehensive reference)
- Refer to official Bluesky docs (authoritative source)

For library issues:
- [atproto GitHub Issues](https://github.com/MarshalX/atproto/issues)
- [Bluesky GitHub Discussions](https://github.com/bluesky-social/atproto/discussions)

---

## Document Metadata

- **Created**: 2026-01-31
- **Research Type**: Bluesky Thread Data Structures & Python Libraries
- **Total Documentation**: 74 KB, 2,224 lines
- **Status**: Complete and ready for implementation
- **Quality**: Production-grade with examples and patterns

---

**Start Here**: BLUESKY_QUICK_REFERENCE.md (5-minute overview)
**Deep Dive**: BLUESKY_RESEARCH.md (comprehensive reference)
**Code Now**: BLUESKY_IMPLEMENTATION_EXAMPLES.md (working examples)
**Quick Decision**: BLUESKY_RESEARCH_SUMMARY.txt (executive summary)

