# DESIGN.md | Atelier Plans

> Hello, Claude Code. This document tells you how to author **HTML plans** for this project
> instead of Markdown. The visual system is already built: you write semantic HTML using the
> component vocabulary below, and the page renders as a styled, browser-editable planning document.
>
> **Do not invent new CSS classes.** Use the ones listed here. Do not add `<style>` blocks. Do not
> inline `style="..."` attributes except for the few documented knobs (e.g. `--cols` on `.phases`).
> The whole point of this system is to remove styling decisions from your plate.

---

## 1. When to use HTML plans

Reach for an HTML plan instead of a Markdown one when **any** of these apply:

- The plan is long enough that scannability matters (≥ 3 sections)
- The plan contains a diagram, a flowchart, a state machine, or a sequence
- The plan has tasks, decisions, risks, or acceptance criteria the user will tick off
- The plan will be revised multiple times: the user can edit it in the browser
- The plan will be shared, reviewed, or printed

For one-shot scratch notes or short answers, plain Markdown is still better.

**File location.** Put plans in `plans/<area>/<slug>.html` next to the codebase they describe.
Copy `plan-template.html` as the starting point: it is **self-contained** (CSS and runtime are
inlined in `<style>` and `<script>` blocks at the top). A plan is one HTML file. No build step,
no shared dependencies, no asset paths to fix.

If you prefer shared assets across many plans, extract the inlined `<style id="plan-css-inline">`
and `<script id="plan-js-inline">` blocks into `plan.css` and `plan.js` and reference them with
`<link>` / `<script src>`. The runtime is identical either way.

---

## 2. The shell

Every plan starts from the `plan-template.html` skeleton. Copy the whole file. The structure
looks like:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>[Plan title] | Atelier Plans</title>
  <meta name="description" content="[One-line summary]">
  <style id="plan-css-inline">  /* visual system: do not edit */  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-core.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
</head>
<body>
<div class="page">
  <header class="topbar">…</header>
  <article class="doc">…</article>
  <aside class="rail"><div class="rail-toc"><h5>On this page</h5></div></aside>
</div>
<script id="plan-js-inline">  /* runtime: do not edit */  </script>
</body>
</html>
```

**Only edit:** `<title>`, `<meta name="description">`, the contents of `<header class="topbar">`,
and the contents of `<article class="doc">`. Leave the inlined `<style>` and `<script>` blocks
untouched.

The right-rail TOC, section numbering, reading progress, and edit affordances are all wired
automatically by the inlined runtime. You don't add them.

---

## 3. Authoring rules

1. **Sections are `<section>` containing one `<h2>`** followed by body content. Section numbers
   are auto-generated; do not write "1.", "2." etc. in the heading text.
2. **Lead with intent.** First section is `<h2>Intent</h2>` and contains a Goal callout, a
   Non-goals callout, and an Open Questions callout. Skip any that don't apply.
3. **One diagram early.** If the plan describes a system, put a Mermaid flowchart or sequence
   diagram inside the **Design** section, not buried at the end.
4. **Use the lede paragraph sparingly.** `<p class="lede">` is for one italic framing sentence
   per major section. Don't use it in every section.
5. **Use callouts to draw the eye.** Plain prose for ordinary paragraphs; callouts (`.callout`)
   for things the reader must not miss. Use `data-kind="caveat"` for "known wrinkle, deferred"
   asides and `data-kind="rationale"` for "why we chose this" boxes.
6. **Use ID-lists for Goals / Non-goals / Invariants.** When each item is a substantial
   paragraph with a label (G1, NG2, I3, Q4), reach for `<ol class="id-list">` (see §4.14)
   rather than a `<ul>` inside a callout. The list items become anchorable from elsewhere
   in the doc.
7. **Use `<a class="xref">§Section</a>` for spec-internal references.** Use
   `<a class="xref doc">docs/path.md</a>` for document references. Reserve plain `<a>`
   for external links and navigation.
8. **Tables are for tabular data**, not layout. The risks table, rollout table, and
   resolved-questions table are first-class; everything else is prose or a structured component.
9. **Tasks are editable.** Wrap actionables in `<ol class="tasks">` so the user can tick them off
   in the browser; do not put actionables in plain `<ul>`.
10. **Code blocks** use `.code-block` with filename + lang. For short illustrative snippets
    without a header, use `.code-block.compact` (see §4.18).

---

## 4. Component vocabulary

### 4.1 Document header

```html
<header class="doc-header">
  <div class="doc-eyebrow">
    <span class="dot"></span>
    <span>Feature design · RFC-014</span>
    <span class="status" data-status="in-review" data-editable></span>
  </div>
  <h1 class="doc-title">Plan title with a <em>memorable</em> phrase</h1>
  <p class="doc-summary">One- or two-sentence summary.</p>
  <dl class="doc-meta">
    <div><dt>Author</dt><dd>name</dd></div>
    <div><dt>Reviewers</dt><dd>names</dd></div>
    <div><dt>Started</dt><dd>YYYY-MM-DD</dd></div>
    <div><dt>Target</dt><dd>YYYY-MM-DD or sprint</dd></div>
    <div><dt>Tickets</dt><dd><a href="#">LINK-123</a></dd></div>
    <div><dt>Tags</dt><dd class="tags"><span class="tag">backend</span></dd></div>
  </dl>
</header>
```

- Wrap one or two words in `<em>` inside `.doc-title` for the terracotta italic emphasis.
- `data-status` values: `draft`, `in-review`, `approved`, `shipped`, `blocked`.
- Drop meta `<div>`s that don't apply. Don't write "TBD": omit.

### 4.2 Section heading

```html
<section>
  <h2>Design</h2>
  …
</section>
```

For collapsible (deep-detail) sections, add `class="collapsible"` to the `<section>`.

### 4.3 Callouts: the structural primitives

```html
<div class="callout" data-kind="goal">
  <span class="callout-label">Goal</span>
  <div class="callout-body"><p>…</p></div>
</div>
```

Kinds: `goal` (moss), `non-goal` (muted), `question` (ochre), `assumption` (neutral),
`risk` (terracotta), `key` (terracotta-soft, for the one big idea), `note` (dashed),
`caveat` (dashed, muted: for "known wrinkle" asides) `rationale` (code-bg, moss: for
"why we chose this" boxes).

### 4.4 Decision (ADR-style)

```html
<div class="decision">
  <div class="decision-head">
    <span class="decision-id">ADR-014.1</span>
    <h3 class="decision-title">Decision title: verb-led</h3>
    <span class="status" data-status="approved" data-editable></span>
  </div>
  <p><strong>Context.</strong> …</p>
  <p><strong>Decision.</strong> …</p>
  <p><strong>Consequences.</strong> …</p>
  <dl class="decision-meta">
    <dt>Alternatives</dt><dd>A, B, C</dd>
    <dt>Owner</dt><dd>name</dd>
  </dl>
</div>
```

### 4.5 Task list

```html
<ol class="tasks">
  <li data-status="todo">
    <span class="task-check"></span>
    <span class="task-text">Implement the encoder.</span>
    <span class="task-owner">@owner</span>
    <span class="task-est">1d</span>
  </li>
</ol>
```

Statuses: `todo`, `doing`, `done`, `blocked`. The check pill is **clickable** in the
browser: it cycles through statuses and persists to localStorage. Always include all four
spans even if owner/est are `: `.

### 4.6 Changeset (file tree of code changes)

```html
<div class="changeset">
  <div class="changeset-head">
    <span>files affected · 12</span>
    <span class="counts"><span class="add">+5</span><span class="mod">~6</span><span class="del">−1</span></span>
  </div>
  <ul class="tree">
    <li data-op="add"><span class="op">+</span><span class="path">path/to/new.ts</span><span class="note">purpose</span></li>
    <li data-op="mod"><span class="op">~</span><span class="path">path/to/existing.ts</span><span class="note">change</span></li>
    <li data-op="del"><span class="op">−</span><span class="path">path/to/old.ts</span><span class="note">reason</span></li>
  </ul>
</div>
```

### 4.7 Diff block

```html
<details class="diff">
  <summary>diff · path/to/file.ts</summary>
  <div class="diff-body">
    <div class="line ctx">function handle(req) {</div>
    <div class="line del">  return legacy(req);</div>
    <div class="line add">  return next(req);</div>
    <div class="line ctx">}</div>
  </div>
</details>
```

### 4.8 Code block

```html
<div class="code-block">
  <div class="code-head">
    <span class="filename">events.ts</span>
    <span class="lang">typescript</span>
  </div>
  <pre><code class="language-ts">…source…</code></pre>
</div>
```

Prism auto-loads the language grammar via the autoloader; just put the right
`language-xxx` class on the inner `<code>`. The Copy button is added by `plan.js`.

### 4.9 Phases (rollout swimlane)

```html
<div class="phases" style="--cols: 5;">
  <div class="phase" data-state="done">
    <div class="phase-label">Phase 0</div>
    <h4 class="phase-title">Ideate</h4>
    <ul><li>item</li></ul>
  </div>
  …
</div>
```

States: `done`, `active`, `future`. Set `--cols` to the phase count (3–6 ideal).

### 4.10 Risks table

```html
<table class="risks">
  <thead><tr><th>Risk</th><th>Severity</th><th>Likelihood</th><th>Mitigation</th></tr></thead>
  <tbody>
    <tr>
      <td>…</td>
      <td class="severity" data-sev="med">Medium</td>
      <td>Likely</td>
      <td>…</td>
    </tr>
  </tbody>
</table>
```

Severity values: `low`, `med`, `high`.

### 4.11 2×2 matrix

```html
<div class="matrix">
  <div></div>
  <div class="axis-x">Low impact</div>
  <div class="axis-x">High impact</div>
  <div class="axis-y">High effort</div>
  <div class="cell"><span class="cell-label">low / high</span><p>…</p></div>
  <div class="cell"><span class="cell-label">high / high</span><p>…</p></div>
  <div class="axis-y">Low effort</div>
  <div class="cell"><span class="cell-label">low / low</span><p>…</p></div>
  <div class="cell"><span class="cell-label">high / low</span><p>…</p></div>
</div>
```

### 4.12 Spec relations (Depends on / Blocks / Supersedes)

For technical specs that depend on other docs. Sits below `.doc-meta` inside `.doc-header`.

```html
<div class="relations">
  <div class="relation" data-kind="depends">
    <span class="relation-label">Depends on</span>
    <div class="relation-body">
      <a class="xref doc" href="#">docs/architecture.md</a>
      (<a class="xref" href="#">SectionName</a>); root <a class="xref doc" href="#">CLAUDE.md</a>
    </div>
  </div>
  <div class="relation" data-kind="blocks">
    <span class="relation-label">Blocks</span>
    <div class="relation-body">the next-stage implementation plan</div>
  </div>
</div>
```

`data-kind` values: `depends` (moss), `blocks` (terracotta), `amended` (ochre).

### 4.13 Amendment note

Sits after `<header class="doc-header">` to mark that the doc was revised post-publication.

```html
<aside class="amendment">
  <span class="amendment-label">Amended 2026-05-18</span>
  <p>Post-implementation corrections; see the changelog entry in <a class="xref doc" href="#">docs/architecture.md</a>.</p>
</aside>
```

### 4.14 ID-list: Goals, Non-goals, Invariants, Resolved-questions

The spec-specific pattern: numbered, labeled paragraphs with an ID prefix (G1, NG2, I3, Q4).
Replaces the callout-with-ul approach when each item is a substantial paragraph.

```html
<ol class="id-list" data-kind="goal">
  <li id="G1">
    <span class="id-tag">G1</span>
    <div class="id-body">
      <code>ToolCapability</code> reads <code>trust_class</code> from each tool's metadata
      and acts on it at the <code>before_tool_execute</code> boundary: verified by unit tests.
    </div>
  </li>
  <li id="G2">…</li>
</ol>
```

`data-kind` values: `goal` (moss), `non-goal` (muted), `invariant` (terracotta-soft),
`question` (ochre), `risk` (red). Always give each `<li>` an `id` (`G1`, `NG1`, `I1`, `Q1`)
so later paragraphs can link to it with `<a href="#G1">G1</a>`.

### 4.15 Cross-reference (`xref`) link

For `§section-name` and `path/to/doc.md` references in dense technical prose. The class
renders a subtle moss-toned pill so spec-internal references stand apart from external links.

```html
See <a class="xref" href="#sec-design">ToolCapability</a> in this doc and
<a class="xref doc" href="docs/architecture.md">docs/architecture.md</a> for the contract.
```

- Plain `.xref`: prefixed `§` (section reference).
- `.xref.doc`: prefixed `⧉` (document reference).

Reserved for cross-references in spec prose. Don't use it for navigation links: those are
ordinary `<a>` elements.

### 4.16 Journey / scenario block

A structured walkthrough: identifier, title, pre-conditions, and numbered steps.
Use for user-journey scenarios, test scenarios, or any procedural walkthrough.

```html
<div class="journey">
  <div class="journey-head">
    <span class="journey-id">J-skills-01</span>
    <h3 class="journey-title">Author and activate a skill</h3>
  </div>
  <div class="journey-body">
    <section>
      <h4>Pre-conditions</h4>
      <ul>
        <li>A project skill directory exists with one valid <code>SKILL.md</code>.</li>
      </ul>
    </section>
    <section>
      <h4>Steps</h4>
      <ol class="journey-steps">
        <li>Start an agent; the catalog appears in <code>Run.instructions</code>.</li>
        <li>The agent calls <code>Skill(name)</code>.</li>
      </ol>
    </section>
  </div>
</div>
```

### 4.17 Prompt-stack diagram

A visual ordered list of named XML-tagged blocks that compose into a final string
(prompt assembly, contributor chain, layered configuration).

```html
<ol class="prompt-stack">
  <li data-state="first">
    <span class="stack-tag">ROLE</span>
    <span class="stack-body"><strong>Frame</strong>: scaffold role contract.</span>
  </li>
  <li>
    <span class="stack-tag">PERSONA</span>
    <span class="stack-body"><strong>Persona</strong>: who the agent is.</span>
  </li>
  <li data-state="deferred">
    <span class="stack-tag">MEMORY</span>
    <span class="stack-body"><strong>Memory</strong>: deferred.</span>
  </li>
</ol>
```

`data-state` values on `<li>`: omit for normal, `first` (ochre, the entry point),
`deferred` (dashed, faded, for slots not yet implemented).

### 4.18 Compact code block (no header)

For short illustrative snippets that don't need a filename + lang header. Add
`class="compact"` to `.code-block`; the empty `.code-head` is hidden by CSS.

```html
<div class="code-block compact">
  <div class="code-head"></div>
  <pre><code class="language-xml">&lt;skill name="pdf"&gt;…&lt;/skill&gt;</code></pre>
</div>
```

### 4.19 Caveat & rationale callouts

Two additional callout kinds for technical specs:

- `data-kind="caveat"`: dashed border, muted background. For "known wrinkle, deferred"
  parenthetical asides that don't rise to the level of a `risk`.
- `data-kind="rationale"`: code-bg, moss accent. For "why we chose this" boxes attached
  to a decision or rule.

```html
<div class="callout" data-kind="caveat">
  <span class="callout-label">Known wrinkle, deferred</span>
  <div class="callout-body"><p>…</p></div>
</div>
```

---

## 5. Diagrams

You have four ways to draw. Pick the lightest one that conveys the idea.

### 5.1 Mermaid: the default for system diagrams

```html
<figure class="diagram">
  <pre class="mermaid">
flowchart LR
  A[Client] --> B[Edge]
  B --> C[Agent]
  C --> D[(Postgres)]
  </pre>
  <figcaption class="figure-caption">Figure 1. Caption.</figcaption>
</figure>
```

The Mermaid theme is pre-configured to match the palette: do not pass `%%{init}%%` blocks.
Mermaid handles `flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `gantt`,
`classDiagram`, `journey`, and `gitGraph`. Reach for sequence diagrams for time/protocol flows,
flowcharts for structure, state diagrams for state machines.

### 5.2 ASCII / box drawing: for small inline diagrams

```html
<pre class="ascii">
  ┌──────────┐    submit    ┌──────────┐
  │ composer │ ───────────▶ │ streaming│
  └──────────┘              └──────────┘
</pre>
```

Use box-drawing characters (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ▶ ◀ ▲ ▼`). Good for state machines,
trees, simple flows. Cheaper to author and edit than a Mermaid block.

### 5.3 Hand-authored SVG: for original illustrations

Use this when you need to convey a concept that no diagram tool draws well: a memory
layout, a packet structure, a UI sketch, a metaphor.

```html
<figure class="figure">
  <svg class="illus" viewBox="0 0 400 200" width="400" height="200">
    <!-- Use the pre-styled classes: -->
    <rect class="fill"     x="20"  y="40" width="120" height="80"/>
    <rect class="accent-f" x="160" y="40" width="80"  height="80"/>
    <path class="stroke"   d="M 20 160 L 380 160"/>
    <path class="muted"    d="M 20 180 L 380 180"/>
    <text class="label"    x="200" y="30" text-anchor="middle">caption inside svg</text>
    <text                  x="80"  y="90">label</text>
  </svg>
  <figcaption class="figure-caption">Figure N. What this shows.</figcaption>
</figure>
```

Available classes inside `svg.illus`:
- `.stroke`  : 1.25px ink stroke, no fill
- `.stroke-2`: 2px ink stroke
- `.fill`    : canvas fill + ink stroke (rectangles, boxes)
- `.accent`  : terracotta stroke
- `.accent-f`: terracotta fill
- `.muted`   : dashed ink-muted stroke (annotations, guides)
- `<text>`   : mono caption-sized
- `<text class="label">`: italic serif label, larger

**Keep SVG simple.** Don't draw complex illustrations or icons. If you find yourself writing
more than ~25 SVG elements, switch to Mermaid or describe the idea in prose.

### 5.4 Sparklines: for inline tiny charts

```html
A <span class="spark" data-values="4,6,5,8,12,9,14,18,22"></span> uptick.
```

Renders inline; pass a comma-separated list of numbers.

---

## 6. Editability

The page is editable in the browser by default. `plan.js` automatically:

- Makes headings, paragraphs, list items, table cells, blockquotes, and callout bodies
  `contenteditable`.
- Cycles task-check status on click (`todo → doing → done → blocked → todo`).
- Cycles status pills on click (`draft → in-review → approved → shipped → blocked → draft`).
- Persists every edit to `localStorage` keyed by the file path.
- Surfaces top-bar buttons: **Edit on/off**, **Print**, **Copy ▾** (dropdown with
  *Copy diff* for iteration paste-back and *Copy markdown* for finalizing the plan
  as `.md` with YAML frontmatter), **Download** (save the edited HTML), **Reset**.

You don't add edit affordances. They appear because the markup uses the recipes above.

When the user returns with feedback, they will paste back a block beginning with
`# Edits to apply (Atelier Plans)`: apply those text changes to the source HTML.

---

## 7. Voice and structure conventions

- **Titles** are statements with character. `Make the chat feel alive: stream tokens as they arrive`
  beats `Streaming responses feature design`. Use `<em>` to italicize the memorable phrase.
- **Summaries** name the change and the user-visible payoff in one breath. ≤ 35 words.
- **Section names** are nouns, single words preferred: `Intent`, `Context`, `Design`, `Decisions`,
  `Changeset`, `Phases`, `Tasks`, `Risks`, `Acceptance`, `Rollout`. Add others only if needed.
- **No tables of contents in body.** The right rail builds one automatically.
- **No emoji.** No icons in prose. The visual system carries the affordances.
- **One key insight per plan.** Mark it with `data-kind="key"` so the eye can find it.

---

## 8. Files in this kit

```
DESIGN.md              ← you are here
README.md              ← human-facing overview
plan-template.html     ← copy this to start a new plan (self-contained: CSS+runtime inlined)
EXAMPLE-plan.html      ← realistic worked example; read it for tone
plan.css               ← same visual system, extracted (optional, if you want shared assets)
plan.js                ← same runtime, extracted (optional)
```

When starting work:

1. `cp plan-template.html plans/<area>/<slug>.html`
2. Leave the inlined `<style>` and `<script>` blocks alone.
3. Fill the recipes from §4–§5 above.
4. Hand the file path to the user; they'll open it in a browser.

---

## 9. Libraries available (loaded by template)

- **Mermaid 10.9**: diagrams via `<pre class="mermaid">`. <https://mermaid.js.org/intro/>
- **Prism 1.29** + autoloader: syntax highlighting on `<code class="language-…">`.

If you need more, you may add a single `<script src="...">` tag in the `<head>`. Candidates
worth knowing about:

- **D3 7**: custom data viz. Only when Mermaid can't express the idea.
- **Chart.js 4**: simple line/bar/donut charts.
- **Reveal.js**: if a plan needs to double as a presentation.

Default to *no* additional library. Prose, tables, callouts, and Mermaid cover ~95% of needs.

---

## 10. What this system optimises for

- **Scannable.** Eye paths land on headings, callouts, decisions, and tasks before prose.
- **Editable.** The user can fix, tick, and reshape without re-prompting you for minor changes.
- **Reviewable.** Status pills, ADRs, and the right rail let reviewers find the moving parts.
- **Printable.** Clean print styles for handoff to stakeholders who want PDF.
- **Boring.** No animation tricks, no novel UI, no surprise. Cognitive surface is reserved
  for what the plan *says*, not how it looks.

That last one is the point. The visual system is finished so you can stop thinking about it.
