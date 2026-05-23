# HTML Authoring Guide (writing-plans)

When the user accepts the HTML iteration offer in `SKILL.md`, you author the plan as styled, editable HTML using the template and design vocabulary co-located with this guide. The output is one self-contained HTML file the user opens in a browser. They can edit prose inline, tick task boxes, cycle statuses, and copy the result back to chat as a paste-back diff or finalize as Markdown with YAML frontmatter.

The visual system is finished. Your job is to write semantic HTML using the component vocabulary in `references/DESIGN.md` — not to invent CSS classes.

## Workflow

1. **Pick a tone reference.** Skim one example in `references/` whose document type is closest to what you're writing:
   - `EXAMPLE-rfc.html`: feature-design RFC (product / feature plan tone)
   - `EXAMPLE-spec-skills-and-tools.html`: architecture-grade technical spec with Goals/Non-goals/Invariants, journeys, prompt-stack diagram
   - `EXAMPLE-spec-consumer-demo.html`: companion spec demonstrating cross-document `xref` references

2. **Copy the template.** `cp .claude/skills/writing-plans/assets/plan-template.html docs/plans/html/YYYY-MM-DD-<feature>.html`. The template is **self-contained**: CSS and runtime are inlined in `<style id="plan-css-inline">` and `<script id="plan-js-inline">` blocks at the top. No build step, no shared assets to fix.

3. **Edit only four things:**
   - `<title>` and `<meta name="description">`
   - The breadcrumbs inside `<header class="topbar">`
   - The contents of `<article class="doc">`
   - Leave the inlined `<style>` and `<script>` blocks alone

4. **Read `references/DESIGN.md` before authoring.** It contains the full component vocabulary, copy-pasteable HTML recipes, authoring rules, and diagram options. Consult it whenever you need a component. **Do not invent CSS classes outside it.**

5. **Author by following the recipes.** Lead with `<h2>Intent</h2>` (or `<h2>Goals</h2>` for specs). Put one diagram in the Design section. Mark one key insight per plan with `data-kind="key"`. Use `<ol class="id-list">` for Goals/Non-goals/Invariants when each item needs a stable ID. See "Voice and structure conventions" below.

6. **Validate before handing off.** Confirm:
   - You used only classes documented in `references/DESIGN.md`
   - No emoji or icons in prose; the visual system carries the affordances
   - No table of contents in the body: the right rail builds one automatically
   - Status pill, Copy ▾ menu, and edit affordances are present (they're wired by the runtime)
   - Title contains exactly one `<em>` phrase for memorable emphasis
   - Summary names the change and the user-visible payoff in ≤ 35 words

7. **Hand off the HTML file.** Tell the user the file path and that they can open it in any browser. Mention the two copy primitives explicitly the first time (see next section).

## The user's runtime: the two copy primitives

These are wired by the inlined runtime; you don't need to add them. But you must understand them because they shape the iteration loop:

- **Copy diff**: generates a paste-back block that begins `# Edits to apply (Atelier Plans)` followed by the user's text changes. When the user pastes this into chat, **read it carefully and apply the text changes to the source HTML.** This is the primary iteration mechanism: user edits in the browser → Copy diff → paste → you patch the file → user reloads.
- **Copy markdown**: finalizes the plan as `.md` with YAML frontmatter when the user is ready to commit it to the repository as Markdown. They typically use this once the plan is approved. The Markdown output is what writing-plans' execution handoff consumes — HTML is never the handoff form.

Other browser controls (you don't add these):

- Inline-editable prose (headings, paragraphs, list items, table cells)
- Click task checkbox → cycle `todo → doing → done → blocked`
- Click status pill → cycle `draft → in-review → approved → shipped → blocked`
- **⌘E / Ctrl+E**: toggle edit mode
- **⌘S / Ctrl+S**: download edited HTML
- Print stylesheet hides chrome and paginates cleanly

## Component vocabulary (high-level)

Full recipes and copy-pasteable HTML are in `references/DESIGN.md`. Brief inventory:

**Document chrome**
- `.doc-header`: title (with one `<em>` phrase), summary, metadata (author, date, tickets, tags)
- `.relations`: for technical specs: Depends on / Blocks, with `<a class="xref doc">` link chips
- `.amendment`: short note marking that a doc was revised post-publication
- `.status[data-status]`: pill (draft, in-review, approved, shipped, blocked): user-cyclable

**Prose primitives**
- `.callout[data-kind]`: goal, non-goal, question, assumption, risk, key, caveat, rationale, note
- `<p class="lede">`: one italic framing sentence per major section (use sparingly)
- `<a class="xref">`: for `§SectionName` references; `<a class="xref doc">` for `docs/path.md`

**Structured blocks**
- `<ol class="id-list" data-kind>`: for Goals (G1…), Non-goals (NG1…), Invariants (I1…); each `<li>` has a stable `id` for cross-references
- `.decision`: ADR-style decision block (Context / Decision / Consequences / Alternatives)
- `.journey`: scenario walkthrough with id, title, pre-conditions, numbered steps
- `<ol class="tasks">`: checkbox tasks with owner + estimate; user cycles status

**Code & diffs**
- `.code-block`: code with filename + lang header (Prism-highlighted); `.code-block.compact` for headerless snippets
- `<details class="diff">`: inline diff blocks with `+`/`-`/context lines
- `.changeset`: file-by-file `+`/`~`/`−` change list with notes

**Layout & data**
- `.phases`: Ideate / Design / Build / Test / Ship swimlane with `done`/`active`/`future` states
- `.risks` table with `data-sev="low|med|high"` severity coloring
- `.matrix`: 2×2 matrix (effort × impact, etc.)
- `.prompt-stack`: visual layered list of named XML-tagged blocks (composer chains, prompt assembly)

## Diagrams

Pick the lightest option that conveys the idea: see `references/DESIGN.md` §5 for full syntax.

1. **Mermaid** (`<pre class="mermaid">` inside `<figure class="diagram">`): default for flowcharts, sequence, state, ER, gantt, class diagrams. Theme is pre-configured; **do not pass `%%{init}%%` blocks**.
2. **ASCII** (`<pre class="ascii">`): small inline state machines and trees using box-drawing characters.
3. **Hand-authored SVG** (`<svg class="illus">`): original conceptual illustrations. Use pre-styled classes (`.stroke`, `.fill`, `.accent-f`, `.muted`). Keep under ~25 elements; switch to Mermaid otherwise.
4. **Sparklines** (`<span class="spark" data-values="…">`): tiny inline charts.

## Voice and structure conventions

- **Titles are statements with character.** `Make the chat feel alive: stream tokens as they arrive` beats `Streaming responses feature design`. Wrap one phrase in `<em>` for terracotta italic emphasis.
- **Summaries** name the change and the user-visible payoff in one breath. ≤ 35 words.
- **Section names** are nouns, single words preferred: `Intent`, `Context`, `Design`, `Decisions`, `Changeset`, `Phases`, `Tasks`, `Risks`, `Acceptance`, `Rollout`. For technical specs add `Goals`, `Non-goals`, `Invariants`, `Journeys`, `Resolved questions`, `Forward-compatibility`, `Interfaces`, `References`.
- **Lead with intent.** First section is `Intent` (or `Goals` for specs). Put must-not-miss content in callouts or id-lists.
- **One diagram early.** If the plan describes a system, the first diagram appears in the Design section, not at the end.
- **One key insight per plan.** Mark with `<div class="callout" data-kind="key">` so the eye can find it.
- **No emoji. No icons in prose.** The visual system carries the affordances.
- **No tables of contents in body**: the right rail builds one automatically.

## Reference files

Read on demand:

- `references/DESIGN.md`: full component vocabulary, copy-pasteable HTML recipes, authoring rules, diagram syntax. **Consult before authoring; do not invent CSS classes.**
- `references/EXAMPLE-rfc.html`: product/feature plan tone
- `references/EXAMPLE-spec-skills-and-tools.html`: technical spec tone (G1–G8, NG1–NG7, I1–I4, prompt-stack diagram, journeys)
- `references/EXAMPLE-spec-consumer-demo.html`: cross-document xref example

## Asset files

- `assets/plan-template.html`: **the file you copy** to start a new plan. Self-contained (CSS + runtime inlined).
- `assets/plan.css`, `assets/plan.js`: standalone versions of the inlined CSS and runtime. Use only if the user explicitly wants shared assets across many plans; otherwise the template's inlined versions are sufficient.

## Customizing the visual system

If the user wants to change the look:

1. Edit `assets/plan.css` and/or `assets/plan.js` to taste.
2. Re-inline them into `assets/plan-template.html`: find the `<style id="plan-css-inline">…</style>` and `<script id="plan-js-inline">…</script>` blocks and paste the updated contents.
3. Future plans pick up the changes; existing plans keep rendering with their inlined copies.
4. If the change adds new components or classes, update `references/DESIGN.md` so the vocabulary stays the source of truth.
