# Project TODOs

Durable project-improvement items that don't belong in a phase plan or tbc-notes. Pick up when the cost of NOT having the change exceeds the cost of making it.

## Skills

### Scale back writing-plans level of detail

**What.** writing-plans currently prescribes complete implementation code in task bodies. Plans should document contracts (interfaces, behavior, acceptance criteria, data models/schemas, fixture content) and let the implementer choose how to satisfy them. Show only:

- Data models, schemas, fixture file content (these are contracts, not implementation)
- Small illustrative snippets when clarifying intent (1-3 lines, not full file bodies)

Plans should NOT prescribe:

- Function bodies, control flow, error handling specifics
- Naming choices for internal variables
- Step-by-step file rewrites with full source

**Why.** Scott surfaced this during phase 0 planning (2026-05-22): "Plan looks too good. We've left nothing for the implementer to think about or decide." The implementer in the public repo is another full Claude Code instance, not a subagent: it has its own context and should make implementation choices itself. Prescriptive plans defeat the two-instance split and remove the learning value.

**Where.** `.claude/skills/writing-plans/SKILL.md` — the "Task Structure" section currently says "Complete code in every step", which is the prescriptive rule. Loosen to: tasks document interfaces, behavior contracts, test cases (what to verify, not exact code), and acceptance criteria. The TDD step pattern (write failing test → run → implement → run → commit) still applies; the test and implementation code itself is left to the implementer.

**When.** Before the next phase plan (phase 1 transcripts). Doing this between phase 0 and phase 1 lets the phase-0 plan stand as a transitional artifact and lets phase 1 onward use the leaner format.

**Tradeoff.** Leaner plans require the implementer instance to think harder and may produce different implementation choices than the planner would. That is the goal, not a cost.
