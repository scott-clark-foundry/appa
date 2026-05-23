---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write implementation plans that document **contracts**, not implementation. The reader is the implementer: another capable engineer (often another full Claude Code instance) with access to the codebase, library docs, and reference docs in `docs/references/`. Tell them what must be true after each task (interfaces, schemas, behaviors, acceptance criteria), and let them choose how to satisfy it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

The plan is one half of the handoff; the other half is the reference docs the plan links to (see `## Reference Docs` below). Together they carry the cross-phase context; the plan body itself stays focused on what *this* phase delivers.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Save plans to:**
- Markdown (canonical, default): `docs/plans/YYYY-MM-DD-<feature-name>.md`
- HTML (only if the user accepts the interactive iteration offer below): `docs/plans/html/YYYY-MM-DD-<feature-name>.html`. The Markdown export remains the canonical artifact that `subagent-driven-development` consumes.
- (User preferences for plan location override these defaults)

## Interactive HTML Iteration

A browser-based authoring surface for the implementation plan, parallel to brainstorming's Visual Companion but for the plan document itself. The infrastructure (template, styling, runtime) lives at `.claude/skills/writing-plans/assets/`; the authoring guide lives in `html-authoring.md` (sibling of this file). Available as a tool — not a mode. Accepting the tool means the plan is drafted as styled HTML the user can edit inline and round-trip back; declining means the plan is written as plain Markdown directly. Either way, Markdown is the canonical handoff form.

**Offering the tool:** Right after the "I'm using the writing-plans skill" announcement, make the offer as its own message:

> "Plans are easier to iterate on as styled HTML you can edit in a browser, especially for longer plans. I can produce the plan as a self-contained HTML file you can open locally, edit inline (status pills, task checkboxes, prose), then either paste a diff back here for me to revise, or click Copy markdown to finalize. This requires opening a local file in your browser. Want to use it? (Plain Markdown is the default if you'd rather skip the browser round-trip.)"

**This offer MUST be its own message.** Do not combine it with content from the plan, scope-check observations, or any clarifying questions. Wait for the user's response before continuing.

**Scaling rule:** for trivial plans (one or two tasks, no architectural decisions, a small touch-up), skip the offer entirely and write plain Markdown. Don't force browser ceremony on small work. The offer is for plans long enough to benefit from inline review.

**If declined:** behave as today. Author the plan in plain Markdown at the canonical path and proceed to self-review and execution handoff.

**If accepted (the iteration loop):**

1. Read `html-authoring.md` (the sibling guide) before authoring. It contains the workflow, component vocabulary, voice conventions, diagram options, and the two copy primitives that shape the iteration loop. Copy the template from `.claude/skills/writing-plans/assets/plan-template.html` to `docs/plans/html/YYYY-MM-DD-<feature-name>.html` and author the plan there. Tell the user the path and that they can open it locally.
2. The user reviews in the browser, edits inline, then chooses one of:
   - **Paste a diff back into the chat.** Read the diff, apply the change, regenerate the HTML at the same path, and return to step 2.
   - **Click Copy markdown to finalize.** The user can either save the result directly to the canonical Markdown path themselves, or paste it back to the chat and you save it. Loop exits.
3. Once the Markdown file exists, treat it as canonical. The user may ask for further Markdown-mode refinement; do that as normal edits. When the plan is ready, proceed to self-review and execution handoff against the Markdown form.

The HTML file is the drafting surface. The Markdown file is the handoff artifact. Do not hand off from the HTML form.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries; for cross-phase tech context, link to a reference doc instead of restating]

**References:** Bullet list of `docs/references/<name>.md` files the implementer should read first. Omit if the plan needs no cross-phase context.

---
```

## Reference Docs

`docs/references/<name>.md` is where cross-phase context lives. The plan body describes *this phase*; reference docs hold conventions, patterns, and contracts that span multiple phases.

**Author a reference doc when:**

- The plan body would otherwise need a paragraph of cross-phase context (tech-stack rationale, project-wide conventions, contracts from earlier phases).
- A pattern is introduced now and will be reused in later phases (e.g., vault-write primitives, a test-seam pattern, a judge-call cache).
- The implementer would otherwise have to dig through earlier plan bodies to learn a project-wide convention.

**Don't author one when:**

- The detail is phase-local. State it inline.
- It is tutorial content for an external library. Link to the library's own docs.
- It is decision rationale. That goes in ADRs or the spec.

Default to NOT creating one. Create when the cost of NOT having it (implementer guesses wrong, phases drift apart) exceeds the cost of writing a short file.

**Structure.**

- One concern per file.
- Plain markdown, short, anchored on the contract or convention.
- Linked from every plan that depends on it via the plan header's `**References:**` line.
- For projects with a planner/implementer split across two repos, follow that project's CLAUDE.md guidance on where the canonical (planner) and live (implementer) copies live.

The implementer may amend the live copy as implementation reveals refinement, the same way it may amend the plan itself. The planner reconciles those amendments into the canonical copy when the next phase is planned.

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Contract:**
- Public signature: `def function(input: InputModel) -> OutputModel`
- Behavior: maps `input.field` to `output.field` per `docs/references/<concern>.md`; raises `ValueError` on empty input.
- Tested by: `test_function_maps_fields_correctly`, `test_function_raises_on_empty_input`.

- [ ] **Step 1: Write the failing tests**

  Write `test_function_maps_fields_correctly` (happy-path mapping) and `test_function_raises_on_empty_input` (the `ValueError`). Test structure (fixtures, parametrize, etc.) is the implementer's call.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `pytest tests/path/test.py -v`
  Expected: FAIL with `ImportError` or `NameError` for `function`.

- [ ] **Step 3: Implement to satisfy the contract**

  Implement `function` in `path/to/file.py`. Keep side effects at the edges; pure mapping logic in the body.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `pytest tests/path/test.py -v`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/path/test.py path/to/file.py
  git commit -m "feat: add function for X"
  ```
````

**What goes inside steps:**

- **Acceptable inline code:** data models (`@dataclass`, `pydantic.BaseModel`), schemas, fixture file content, illustrative 1-3 line snippets when prose alone is ambiguous. These are contracts.
- **Not acceptable:** function bodies, control-flow blocks, error-handling specifics, step-by-step file rewrites with full source. These are implementation; the implementer decides.
- **Contracts vs implementation, by example:** "Returns `Settings` with fields `MODEL`, `OPENAI_API_KEY`, `LOGFIRE_TOKEN`, `VAULT_PATH`, `LOG_LEVEL` defaulting to known values; cached via `lru_cache(maxsize=1)`" is a contract. The full pydantic-settings class body that produces that is implementation.

## No Placeholders

Every step must contain the actual content the implementer needs to act. These remain **plan failures**; never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases" (specify *which* errors, *which* inputs, *which* edges)
- "Write tests for the above" (specify which behaviors the tests must verify and what they assert)
- "Similar to Task N" (the implementer may read tasks out of order; restate the contract)
- References to types, functions, methods, or reference docs that no task or doc defines

What counts as "the actual content" depends on the step kind:

- **Contract steps** (schemas, signatures, fixtures, test-behavior descriptions): code blocks required.
- **Implementation steps** (function bodies, control flow): prose acceptance is fine; reach for a 1-3 line snippet only when it clarifies intent.
- **Verification steps** (run a command, check output): exact command and expected outcome required.

## Remember
- Exact file paths always
- Contracts in steps, not implementation: schemas, signatures, fixtures, and test-behavior assertions get code blocks; function bodies do not
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits
- Link to `docs/references/<name>.md` for cross-phase context; do not repeat it inline

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

Handoff fires from the **Markdown** form regardless of whether the plan started in HTML or Markdown. If the plan is still HTML at this point (the user iterated in the browser but hasn't yet exported), ask the user to click Copy markdown and save it to the canonical Markdown path before handoff.

After the Markdown plan is saved, hand off to execution:

**"Plan complete and saved to `docs/plans/<filename>.md`. Ready to execute via subagent-driven-development: I'll dispatch a fresh subagent per task and review between tasks. Say the word and I'll start."**

**REQUIRED SUB-SKILL:** Use subagent-driven-development. Fresh subagent per task + two-stage review.
