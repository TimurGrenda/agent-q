---
name: aq-plan
description: "Interactive task planning with agent-q persistence. Clarifies requirements, explores codebase, outputs plan + agentq/agentqctl tasks. Triggers: aq-plan, aq plan, /aq-plan"
allowed-tools:
  - Task
  - Bash
  - Read
  - Glob
  - Grep
  - Write
  - AskUserQuestion
user-invocable: true
---

# AQ Plan Skill

Interactive, thorough task planning in three phases: clarify WHAT, research HOW, output plan + agent-q tasks. Uses `agentq/agentqctl` for persistent, file-backed task storage.

## Input

The user provides an initial goal, feature request, or problem description. This may be vague -- that's expected.

## Phase 1: Clarify WHAT to do

The goal of this phase is to reach an **exhaustive, airtight** understanding of the task before touching any code. You are a skeptical architect doing due diligence -- not a polite assistant taking an order. Assume the initial request is incomplete and underspecified until proven otherwise.

### Process

1. Read the user's initial request carefully.
2. Before asking anything, do quick codebase lookups (Glob/Grep/Read) to understand the current state relevant to the request. This lets you ask **informed** questions, not generic ones.
3. Ask clarifying questions in **batches of 3-4** using AskUserQuestion. **Minimum 2 rounds** of questions before considering moving on. Most tasks will need 3-5 rounds.
4. After each batch of answers, **actively generate new questions** from the answers:
   - Each answer likely introduces new assumptions -- probe them.
   - If the user says "just do X", ask *why* X and whether alternatives were considered.
   - If the user picks a trade-off, explore the consequences of that choice.
   - If the user says "doesn't matter" or "whatever is simplest", push back once -- surface a concrete scenario where it *would* matter and ask if they've considered it.
5. Loop aggressively. Don't rush to Phase 2. It's much cheaper to ask one more question now than to rewrite code later.
6. It's fine for the task to **change entirely** through this discussion. The original request is a starting point, not a contract.

### Question categories to systematically cover

For every task, work through these categories. Not all apply to every task, but **actively consider each one** and ask about any that are relevant:

**Scope & Boundaries**
- What's explicitly in scope? What's explicitly out?
- Where does this feature/change start and stop?
- Are there adjacent features that will be affected? Should they be updated too, or left alone?
- Is this a one-off or the first step of a larger effort? (This changes how you design it.)

**Behavior & Semantics**
- What is the exact expected behavior, step by step?
- What inputs/data does this handle? What are the valid ranges/formats?
- What happens with empty input, null, zero, negative values, extremely large values?
- What's the default behavior? What's configurable vs hardcoded?
- If there's a UI component -- what does the user see at every state? (Loading, empty, error, success, partial)

**Edge Cases & Error Handling**
- What happens when things go wrong? (Network failure, invalid data, race conditions, timeouts)
- What happens with concurrent access or duplicate operations?
- What happens at boundaries? (First item, last item, exactly N items, N+1 items)
- What if a dependency is unavailable or returns unexpected data?
- What about backwards compatibility -- does existing data/config still work?

**Integration & Side Effects**
- What else in the system will notice this change? (Other features, APIs, consumers, tests)
- Are there performance implications? (Does this run in a hot path? On large datasets?)
- Are there security implications? (New inputs, new permissions, new data flows)
- Does this change any public API, CLI interface, or configuration format?

**Testing Strategy** *(MANDATORY — must be discussed every time)*
- What testing approach fits this task? Default recommendation: unit tests + E2E tests where applicable.
- Present the default and ask the user to confirm or adjust. Offer concrete options:
  - Unit tests only (small, isolated changes)
  - Unit tests + E2E/integration tests (features with user-facing flows or multi-component interaction)
  - E2E only (thin glue code where unit tests add no value)
  - No tests (trivial config/docs changes — must be explicitly agreed)
- Tests should be written **as part of each task**, not deferred to a final "write tests" task. This is the default because:
  - The implementing agent has full context of the code it just wrote
  - Each task is verified before moving on, catching issues early
  - Code review is more meaningful when tests are included
- If E2E/integration tests need the full feature assembled, create a **separate final task** for those.
- Ask about existing test patterns: test file locations, test utilities, naming conventions.
- Pin down: what level of coverage does the user expect? Which edge cases must have tests?

**Acceptance & Verification**
- How do we know it's done? What are the concrete acceptance criteria?
- Are there observable behaviors we can assert on?

### When to move on

**Do NOT move on until:**
- You have asked at least 2 rounds of questions (minimum)
- Every answer from the last round produced zero new questions -- you've genuinely run out of ambiguities
- The task has clear, hard boundaries (what's in scope, what's not)
- Acceptance criteria are concrete enough to write tests for
- All trade-offs have been decided with the user understanding the consequences
- You could hand the task to a new developer with zero additional context and they'd build exactly the right thing
- You've explicitly asked about edge cases and the user has made decisions on them
- Testing strategy has been discussed and agreed upon (test types, coverage expectations, tests-per-task vs separate)

**Err on the side of one more round of questions.** The user asked for thorough planning -- deliver it.

### Rules

- Don't ask questions you can answer yourself by reading the codebase. Do quick lookups first.
- Don't ask obvious questions -- the user is tech-savvy.
- **DO be relentless.** If an answer is vague, ask a follow-up. If the user says "probably X", pin it down to "definitely X" or "definitely Y".
- DO challenge the user's assumptions if something seems off. Propose alternatives.
- DO surface edge cases and potential conflicts with existing code early.
- DO play devil's advocate -- "What if someone does X? What if Y fails? What about Z?"
- DO explicitly call out when a user's answer opens up a new line of questioning: "You mentioned X -- that makes me wonder about Y and Z."
- Summarize the refined task description after the last round of questions, before moving to Phase 2. Get a final confirmation.

## Phase 2: Research HOW to do it

Deep codebase exploration to produce a concrete implementation plan.

### Process

1. Use Task (subagent_type: Explore) for broad searches, Glob/Grep/Read for targeted lookups.
2. Read **every file** that will be modified or is closely related. Don't skim -- read fully.
3. For each change, identify:
   - Exact file path and line range
   - What exists there now
   - What needs to change and why
   - Dependencies (what else breaks or needs updating if this changes)
4. Look for:
   - Existing patterns in the codebase that the implementation should follow
   - Test files that need updating
   - Config/type changes that cascade
   - Import chains that might be affected

### Research output

Build a mental model of:
- All files involved (modified, created, deleted)
- The order changes should be applied (dependencies first)
- Risks and things that could go wrong
- What can be tested and how

## CRITICAL: State Access Rule

**NEVER read or write files in the `agentq/` directory directly.** All state access
MUST go through `agentq/agentqctl` commands.

## Phase 3: Output

Two deliverables: plan files written via CLI commands, and agent-q epic + tasks.

### 3a. Create the Epic

Write the main plan content to a temp file, then create the epic via CLI:

```bash
# Write plan content to a temp file
cat <<'PLAN_EOF' > /tmp/aq-plan-epic.md
# Plan: <task title>

**Created**: <UTC timestamp>
**Status**: Ready for implementation

## Goal

<1-2 sentence summary of WHAT we're building and WHY>

## Refined Requirements

<Bulleted list of concrete requirements that emerged from Phase 1 discussion>

## Implementation Steps

### Step N: <action title>

**File**: `<path>` (lines X-Y)
**Action**: create | modify | delete
**Details**: <Specific description of what changes. For modifications, describe what's there now and what it becomes. Reference existing patterns when relevant.>
**Depends on**: Step M (if applicable)

### Step N+1: ...

## Files Affected

| File | Action | Description |
|------|--------|-------------|
| ... | modify/create/delete | ... |

## Risks & Open Questions

<Anything that might go wrong or needs runtime verification>

## Testing

<How to verify the implementation works -- which tests to run, new tests needed, manual verification steps>
PLAN_EOF

# Create the epic -- the CLI allocates the ID and copies the plan file
RESULT=$(agentq/agentqctl epic create --title "<plan title>" --file "/tmp/aq-plan-epic.md")
# Parse JSON output: { "success": true, "id": "N-slug" }
EPIC_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['id'])")
```

### 3b. Create Tasks with Plan Files

For each implementation step M, write a self-contained task plan file to a temp file and create the task via CLI. Each task plan must be **self-contained** -- an implementer agent should be able to read it and execute the task without needing the main plan or other context.

Task plan template:

```markdown
# Task M: <action title>

**Plan**: <N-slug>
**Status**: Pending
**Depends on**: Task K (if applicable)

## Goal

<What this task accomplishes in the context of the overall plan>

## Context

<Relevant background: what the affected files look like now, patterns to follow,
imports/types involved, anything the implementer needs to understand>

## Implementation

**File**: `<path>` (lines X-Y)
**Action**: create | modify | delete

<Detailed step-by-step of what to change. For modifications: what's there now -> what it becomes.
Include code snippets where helpful.>

## Verification

<How to verify this task is done correctly -- specific test commands, type-check, manual checks>
```

**For each task, write to temp file and create via CLI:**

```bash
# Write task plan to temp file
cat <<'TASK_EOF' > /tmp/aq-plan-task-M.md
<task plan content>
TASK_EOF

# Create task (no --epic needed -- CLI auto-detects the scaffolding epic)
agentq/agentqctl task create --title "<task M title>" --file "/tmp/aq-plan-task-M.md"
```

For tasks with dependencies, include `--deps` with task numbers:

```bash
agentq/agentqctl task create --title "<task M title>" --file "/tmp/aq-plan-task-M.md" --deps "K"
```

Where `K` is the task number of the dependency (e.g., `--deps "1,2"` for tasks depending on tasks 1 and 2).

### 3c. Finalize the Epic

After all tasks are created, finalize the epic to transition it from `scaffolding` to `open`:

```bash
agentq/agentqctl epic finalize
```

### 3d. Show the Task Tree

Display the full roadmap:

```bash
agentq/agentqctl tasks --epic "$EPIC_ID"
```

Print the output as a formatted table so the user can see the implementation roadmap with IDs, titles, statuses, and dependencies.

### Task Sizing Guidelines

- **Meaningful chunks**: Each task should represent ~5-10 minutes of focused LLM agent work. Group related edits into a single task -- don't split so thin that a task is just changing a return type or editing one line. Conversely, don't make tasks so large they overwhelm a context window.
- **Review-aware**: Every task gets a full 4-agent review cycle, which is expensive. Merging trivially small edits into a neighboring task saves significant review tokens.
- **Ordered**: Express dependencies between tasks via `--deps`.
- **Actionable**: Task plan headings in imperative form ("Add X to Y").
- **Test-inclusive**: By default, each task includes writing its own unit tests. The task plan's Verification section should specify which tests to write, not just which tests to run. Only create a separate testing task for E2E/integration tests that require the full feature to be assembled.

## HARD REQUIREMENT: Do NOT start implementation

**After outputting the plan and task list, STOP.** Give control back to the user. Do NOT begin implementing any tasks, writing any code, or making any changes. The purpose of this skill is planning only -- execution is a separate step that the user will initiate with `/aq-work`.
