---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

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

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

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
