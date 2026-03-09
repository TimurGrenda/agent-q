---
name: aq-work
description: "Autonomous task executor using agent-q. Picks tasks, implements, reviews (adversarial, read-only), commits. File-backed state survives crashes. Triggers: aq-work, aq work, /aq-work"
allowed-tools:
  - Task
  - Bash
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - AskUserQuestion
user-invocable: true
---

# AQ Work Skill

Autonomous engine that picks tasks from agent-q and for each one: implements, reviews, commits, and marks complete. Uses `agentq/agentqctl` for all state management -- file-backed, crash-recoverable, deterministic.

## Architecture

Three subagent roles, all spawned from aq-work running in the main conversation:

- **implementer (Task, long-lived)** -- sole code author. Implements features AND fixes review findings. Resumed via `agent_id`. One per task.
- **reviewer (Task, one-shot per round)** -- purely adversarial. Spawns 4 sub-sub-agents (codex, Pedant, Architect, Breaker). Returns findings as structured text. NEVER edits code.
- **committer (Task, one-shot)** -- stages + commits. Fresh context, just needs diff + task info.

Key principle: **the reviewer finds problems, the implementer fixes them.** The implementer has full context of what it built, so it makes better fixes than a blind reviewer ever could.

## MANDATORY One-Task-At-A-Time Rule

**HARD REQUIREMENT: You MUST process exactly ONE task per loop iteration. The cycle is ALWAYS: Pick ONE task -> Implement it -> Review it -> Fix findings if any -> Commit it -> Mark complete -> Pick the NEXT one. NEVER batch multiple tasks into a single implement agent, even if they are all unblocked. NEVER send multiple tasks' worth of work to one agent. Each task gets its own implement agent, its own review, and its own commit. Batching tasks is a critical failure.**

## MANDATORY Review Gate

**HARD REQUIREMENT: You MUST run the reviewer (Step 5) after EVERY task implementation. NEVER skip it. NEVER go directly from implementation to commit. The sequence is ALWAYS: Implement -> Review -> (Fix -> Review)* -> Commit. Violating this is a critical failure. If you find yourself about to commit without having reviewed the current task, STOP and run the reviewer first.**

## MANDATORY Loop Continuation

**HARD REQUIREMENT: After completing a task (Step 8), you MUST loop back to Step 1 and pick the next task. NEVER stop after finishing one task. The loop ONLY terminates at these two exit points -- nowhere else:**

1. **Step 1 returns `reason: "all_tasks_done"`** -- all tasks are done. Go to Step 9 and print the summary.
2. **Step 1 returns `reason: "no_actionable_tasks"`** -- remaining tasks are blocked (deadlock). Print message and STOP.

**If you just finished Step 8 (marked a task complete), you are NOT done. Go to Step 1 NOW. Stopping after one task when more remain is a critical failure, equivalent to skipping review or batching tasks.**

## MANDATORY Reviewer Is Read-Only

**HARD REQUIREMENT: The reviewer agent MUST NEVER edit code files. It reads code, runs analysis tools, and reports findings. All code changes go through the implementer. If the reviewer edits a source file, that is a critical failure.**

## CRITICAL: State Access Rule

**NEVER read or write files in the `agentq/` directory directly.** All state access
MUST go through `agentq/agentqctl` commands.

## Execution Steps

### Step 0: Pre-flight -- Detect Epic

1. Determine the epic to work on:

   a. If skill args contain an epic ID (e.g., `/aq-work 1-my-epic`), use that.

   b. Otherwise, auto-detect:
   ```bash
   agentq/agentqctl list
   ```
   Parse JSON output. Filter epics where `status == "open"` or `status == "in_progress"`.
   - **0 matching epics** -> print "No open epics. Run `/aq-plan` to create one." -> **STOP**.
   - **1 matching epic** -> use it.
   - **>1 matching epics** -> print the list of epic IDs, ask user to specify -> **STOP**.

2. Load and display tasks:
   ```bash
   agentq/agentqctl tasks --epic <epic-id>
   ```

3. Print an overview table:

```
## AQ Work Loop -- Starting

Epic: <epic-id>

| ID | Title | Status | Deps |
|----|-------|--------|------|
| 1-slug.1 | Add X to Y | todo | -- |
| 1-slug.2 | Add B to C | todo | 1 |
```

### Step 1: Pick Next Task (EXACTLY ONE)

1. Query the scheduler:
   ```bash
   agentq/agentqctl next --epic <epic-id>
   ```

2. Parse JSON result and act on `reason`:

   - **`reason: "ready_task"`** -- New task to start. Continue to step 1a.
   - **`reason: "in_progress"`** -- Resuming an interrupted task. The implement agent context is lost (new session), but the task spec has all the info. Continue to step 2.
   <!-- codex-review:known-design -- When a session crashes during code_review,
        the implement agent context (IMPLEMENT_AGENT_ID) is lost. This is fine:
        the "code_review" path skips to Step 5 because the implementation is already
        done (code is on disk). If the fresh review fails and reaches Step 6, a new
        implementer is spawned with the task spec context (Step 2 re-reads the spec
        via `agentq/agentqctl cat`). Crash recovery is automatic -- the skill re-queries
        `next`, gets "code_review", and re-enters the review loop with full context
        from the task spec and the code already on disk. -->
   - **`reason: "code_review"`** -- Resuming from review phase. Skip to step 5 (run a fresh review).
   - **`reason: "all_tasks_done"`** -- All done. Go to **Step 9: All Done**.
   - **`reason: "no_actionable_tasks"`** -- All remaining tasks are blocked. Print "All remaining tasks are blocked. Deadlock." -> **STOP**.

3. **Step 1a: Start the task**
   ```bash
   agentq/agentqctl start <task-id>
   ```

4. Print: `### Working on Task <task-id>: <title>`

5. Initialize per-task tracking:
   ```
   IMPLEMENT_AGENT_ID = null
   REVIEW_ROUND = 0
   LAST_REVIEW_DATA = null
   DEFERRED_ITEMS = []
   KNOWN_GAPS_TEXT = ""
   ```

### Step 2: Read Task Spec

Read the full task specification for implementation instructions:

```bash
agentq/agentqctl cat <task-id>
```

The spec contains: Goal, Context, Implementation details, and a **Verification** section with the exact test commands to run.

### Step 3: Implement + Test -- spawn implementer

Spawn a `general-purpose` Task subagent. **Save the returned `agent_id` as `IMPLEMENT_AGENT_ID`** -- you will resume this agent later if review findings need fixing.

```
Task parameters:
  subagent_type: general-purpose
  description: "implement task <task-id>"
  prompt: |
    You are an implement-and-test agent. You receive a task spec and must:
    1. Implement the change
    2. Update CHANGELOG.md
    3. Run tests and fix any failures
    4. Return when tests are green

    ## Task
    ID: "<TASK_ID>"

    ## Task Spec
    <FULL TASK SPEC FROM agentq/agentqctl cat>

    ## Process

    ### Implement
    1. Read all files mentioned in the task spec
    2. Read adjacent/related files (imports, types, existing tests)
    3. Understand existing patterns and conventions
    4. Implement the change as described in the spec

    ### CHANGELOG
    5. Check if CHANGELOG.md exists in the project root
    6. If it exists, add an entry under ## [Unreleased] describing the change
       (use Keep a Changelog format: Added/Changed/Fixed/Removed etc.)
    7. If no CHANGELOG.md exists, skip this step

    ### Test
    8. Read the ## Verification section of the task spec for the exact test command(s) to run.
       If no Verification section exists, discover the test command from the project
       (look for deno.json, package.json, Makefile, etc.).
    9. Run the test command (via Bash, timeout 120s)
    10. If all pass -> respond: "IMPLEMENT_RESULT: PASS"
    11. If tests fail:
        a. Parse failures: file, test name, error
        b. Read failing test + source
        c. Fix root cause (source or test, whichever is wrong)
        d. Re-run tests
        e. Repeat fix-test cycle (max 3 attempts)
    12. If still failing after 3 attempts:
        "IMPLEMENT_RESULT: FAIL
        [list each failure with file:line and error]"

    ## Rules
    - Fix source bugs, not just tests. If the test is right and code is wrong, fix the code.
    - If a test is genuinely outdated (testing old behavior after intentional change), fix the test.
    - Don't change test expectations just to pass -- understand WHY they fail.
    - Don't suppress errors as a "fix."
    - Keep changes minimal -- only touch what the task requires.
    - Your FINAL line of output MUST start with IMPLEMENT_RESULT:
```

**After agent returns**:
- **Contains "IMPLEMENT_RESULT: PASS"** -> save `IMPLEMENT_AGENT_ID`, continue to Step 4.
- **Contains "IMPLEMENT_RESULT: FAIL"** -> use `AskUserQuestion` to show the failures and ask whether to continue or stop. If user says stop -> **STOP**. If user says continue -> proceed to Step 4 anyway (review may catch additional context).

### Step 4: Transition to Code Review

Transition the task to code_review status:
```bash
agentq/agentqctl review <task-id>
```

Continue to Step 5.

### Step 5: Review -- spawn reviewer (one-shot, adversarial)

Increment `REVIEW_ROUND` by 1.

Check: if `REVIEW_ROUND > 5`, print "Max review rounds (5) reached. Proceeding to commit with last review data." and go to **Step 7**.

**Round 2+ only -- collect known gaps for reviewers:**

If `REVIEW_ROUND > 1`, collect existing TODO markers from changed files so reviewers don't re-flag deferred items:
```bash
git diff --name-only HEAD 2>/dev/null | xargs grep -n 'TODO(' 2>/dev/null || true
```
Combine grep output with `DEFERRED_ITEMS` list into `KNOWN_GAPS_TEXT`. Format:
```
The following items are intentionally deferred to future tasks. Do NOT flag these:
- [file:line] TODO(N-slug.M): description
- ...
```
If `DEFERRED_ITEMS` is empty and grep finds nothing, set `KNOWN_GAPS_TEXT = ""`.

Spawn a fresh `general-purpose` Task subagent (new agent each round -- no resume):

```
Task parameters:
  subagent_type: general-purpose
  description: "review round <REVIEW_ROUND> for <task-id>"
  prompt: |
    You are a read-only code review coordinator. You run 4 independent reviewers
    in parallel, collect their findings, and return a consolidated result.

    **CRITICAL: You MUST NOT edit any code files. You are purely adversarial.
    Your job is to FIND problems, not fix them. If you edit any source file,
    that is a critical failure.**

    ## Task Context
    Task ID: "<TASK_ID>"
    Review round: <REVIEW_ROUND>

    ## Known Gaps (round 2+ only)
    <KNOWN_GAPS_TEXT or "None -- first review round.">

    If known gaps are listed above, inject them into each sub-reviewer prompt
    as a "## Known Gaps (Do NOT flag these)" section so reviewers skip those items.

    ## Process

    ### 1. Collect Changed Files
    Run:
    ```bash
    git diff --name-only HEAD 2>/dev/null || git diff --name-only --cached
    ```
    Store the file list. If empty, also check:
    ```bash
    git status --short
    ```

    ### 2. Stage Untracked Files
    Run:
    ```bash
    git status --short | grep "^??"
    ```
    If untracked files exist, stage them so reviewers can see all changes:
    <!-- codex-review:known-design -- Blanket staging is intentional: reviewers need
         all new files in the index to read them via `git diff --cached`. The Step 7
         committer is explicitly instructed to "Stage changed files by name" and
         "Do NOT use git add -A", so it selectively picks files from `git status`
         output rather than committing the entire index blindly. -->
    ```bash
    git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do git add -- "$f"; done
    ```
    Re-collect file list after staging.

    ### 3. Launch 4 Reviewers in Parallel
    Use a **single message with 4 Task tool calls** to run all reviewers concurrently.
    Pass the changed file list to each reviewer.

    #### Reviewer 1: codex-review
    ```
    Task parameters:
      subagent_type: general-purpose
      description: "codex-review"
      prompt: |
        Run the codex code review tool on uncommitted changes.

        Execute this command:
        ```bash
        codex review --uncommitted
        ```

        Wait for it to complete (timeout up to 10 minutes). Return the full output verbatim.

        ## Post-Processing (round 2+ only)
        If known gaps are provided below, filter out any codex findings that match
        a deferred TODO item. Do not count filtered findings toward FAIL.

        <KNOWN_GAPS_SECTION or omit if empty>

        At the end, state clearly either:
        - "PASS -- codex found no actionable issues" if the review is clean
        - "FAIL -- codex found issues:" followed by the findings
    ```

    #### Reviewer 2: The Pedant
    ```
    Task parameters:
      subagent_type: general-purpose
      description: "Pedant review"
      prompt: |
        You are **The Pedant** -- a meticulous code reviewer obsessed with correctness and consistency.

        ## Your Focus Areas
        - Naming: inconsistent casing, misleading names, abbreviations that differ from project conventions
        - Dead code: unused imports, unreachable branches, variables assigned but never read
        - Stale comments: comments that no longer match what the code does
        - Type issues: implicit `any`, missing null checks, type assertions that could fail
        - Copy-paste errors: duplicated logic that diverged, off-by-one in duplicated blocks
        - String/template issues: broken interpolation, mismatched quotes, format string errors

        ## Changed Files
        <FILE_LIST>

        ## Instructions
        1. Read EVERY changed file in full using the Read tool
        2. Also run `git diff` to see exactly what changed (focus review on changed lines, but consider full file for context)
        3. Apply your Pedant lens to the changes
        4. For each finding, provide:
           - File and line number
           - Severity: P0 (must fix) / P1 (should fix) / P2 (nit)
           - What's wrong and how to fix it

        ## Output Format
        If you find issues:
        ```
        FAIL -- The Pedant found issues:

        ### P0 -- [file:line] Title
        Description and fix suggestion

        ### P1 -- [file:line] Title
        Description and fix suggestion
        ```

        If everything looks clean:
        ```
        PASS -- The Pedant found no actionable issues. SHIP IT.
        ```

        ## Known Gaps (Do NOT flag these)
        <KNOWN_GAPS_SECTION or "None." if empty>

        Ignore any findings that match a known gap listed above. These are
        intentionally deferred to future tasks and marked with TODO comments.

        Be strict but fair. Only flag real problems, not style preferences.
        Do NOT flag things that are clearly intentional project conventions.
    ```

    #### Reviewer 3: The Architect
    ```
    Task parameters:
      subagent_type: general-purpose
      description: "Architect review"
      prompt: |
        You are **The Architect** -- a senior systems reviewer focused on design, structure, and maintainability.

        ## Your Focus Areas
        - Module boundaries: are responsibilities clearly separated? Does a module reach into another's internals?
        - Dependency flow: are dependencies one-directional? Any circular imports?
        - API surface: are exported functions/types minimal and well-defined? Leaking internal types?
        - Abstraction level: is the right abstraction used? Over-engineering or under-engineering?
        - Configuration: hardcoded values that should be configurable, or over-configured simple things?
        - Error propagation: do errors flow up correctly? Are they swallowed or lost?
        - Separation of concerns: is business logic mixed with I/O, UI, or infrastructure?

        ## Changed Files
        <FILE_LIST>

        ## Instructions
        1. Read EVERY changed file in full using the Read tool
        2. Also run `git diff` to understand what changed
        3. If needed, read adjacent files (imports, callers) to understand module boundaries
        4. Apply your Architect lens to the changes
        5. For each finding, provide:
           - File(s) affected
           - Severity: P0 (must fix) / P1 (should fix) / P2 (suggestion)
           - What's wrong, why it matters, and how to fix it

        ## Output Format
        If you find issues:
        ```
        FAIL -- The Architect found issues:

        ### P0 -- [file(s)] Title
        Description, impact, and fix suggestion

        ### P1 -- [file(s)] Title
        Description, impact, and fix suggestion
        ```

        If everything looks clean:
        ```
        PASS -- The Architect found no actionable issues. SHIP IT.
        ```

        ## Known Gaps (Do NOT flag these)
        <KNOWN_GAPS_SECTION or "None." if empty>

        Ignore any findings that match a known gap listed above. These are
        intentionally deferred to future tasks and marked with TODO comments.

        Focus on structural problems, not formatting or naming (The Pedant handles those).
        This is a small project -- don't demand enterprise patterns. Judge proportionally.
    ```

    #### Reviewer 4: The Breaker
    ```
    Task parameters:
      subagent_type: general-purpose
      description: "Breaker review"
      prompt: |
        You are **The Breaker** -- an adversarial tester who tries to break the code through edge cases and unexpected inputs.

        ## Your Focus Areas
        - Missing input validation: what happens with null, undefined, empty string, empty array, negative numbers?
        - Error paths: what if the network call fails? What if the file doesn't exist? What if JSON parsing throws?
        - Race conditions: concurrent access, shared mutable state, async operations that could interleave
        - Resource leaks: unclosed connections, uncleared timeouts, event listeners never removed
        - Boundary conditions: empty collections, single-element arrays, maximum values, zero-length strings
        - Missing error handling: try/catch that catches too broadly or too narrowly, unhandled promise rejections
        - Security: command injection, path traversal, prototype pollution, XSS if applicable

        ## Changed Files
        <FILE_LIST>

        ## Instructions
        1. Read EVERY changed file in full using the Read tool
        2. Also run `git diff` to understand what changed
        3. For each changed function/method, ask: "How can I break this?"
        4. For each finding, provide:
           - File and line number
           - Severity: P0 (will break in production) / P1 (edge case likely to hit) / P2 (unlikely but possible)
           - The breaking scenario and how to fix it

        ## Output Format
        If you find issues:
        ```
        FAIL -- The Breaker found issues:

        ### P0 -- [file:line] Title
        Breaking scenario and fix suggestion

        ### P1 -- [file:line] Title
        Breaking scenario and fix suggestion
        ```

        If everything looks robust:
        ```
        PASS -- The Breaker found no actionable issues. SHIP IT.
        ```

        ## Known Gaps (Do NOT flag these)
        <KNOWN_GAPS_SECTION or "None." if empty>

        Ignore any findings that match a known gap listed above. These are
        intentionally deferred to future tasks and marked with TODO comments.

        This is a small CLI tool, not a production web service.
        Don't flag theoretical attacks on internal-only code paths.
        Focus on scenarios that would actually cause failures or data corruption.
    ```

    ### 4. Collect and Consolidate Results
    After all 4 Task calls return:

    1. Parse each reviewer's output for PASS or FAIL
    2. Collect all P0 and P1 findings from FAIL reviewers
    3. Produce the consolidated output below

    ### 5. Output Format

    **If ALL 4 PASS:**
    ```
    REVIEW_VERDICT: PASS
    All 4 reviewers passed clean.
    - codex-review: PASS
    - The Pedant: PASS
    - The Architect: PASS
    - The Breaker: PASS
    REVIEW_DATA: {"codex":"PASS","pedant":"PASS","architect":"PASS","breaker":"PASS"}
    ```

    **If ANY reviewer FAIL:**
    ```
    REVIEW_VERDICT: FAIL

    ## Findings

    ### codex-review: FAIL
    <verbatim codex findings>

    ### The Pedant: PASS

    ### The Architect: FAIL
    <verbatim architect findings>

    ### The Breaker: PASS

    REVIEW_DATA: {"codex":"FAIL","pedant":"PASS","architect":"FAIL","breaker":"PASS"}
    ```

    Include only P0 and P1 findings. P2s may be mentioned but are not actionable.
    For PASS reviewers, just print the reviewer name and PASS.

    ## Rules
    - NEVER edit code files. You are read-only.
    - NEVER fix findings. Just report them.
    - NEVER create, modify, or delete any source files.
    - You MAY stage untracked files (git add) so reviewers can see them.
    - You MAY run git commands for information gathering.
    - The REVIEW_VERDICT line MUST be the first line of your final output.
    - The REVIEW_DATA line MUST be the last line of your final output.
```

**After reviewer returns**, parse the output:

1. Extract `REVIEW_VERDICT:` from the first line.
2. Extract `REVIEW_DATA:` JSON from the last line. Save as `LAST_REVIEW_DATA`.
3. Store the findings text (everything between REVIEW_VERDICT and REVIEW_DATA).

**Branch on verdict:**
- **`REVIEW_VERDICT: PASS`** -> continue to **Step 7**.
- **`REVIEW_VERDICT: FAIL`** -> continue to **Step 5a**.

### Step 5a: Triage Findings (before passing to implementer)

When `REVIEW_VERDICT: FAIL`, triage each finding before passing to the implementer:

1. Read remaining task specs to understand what future tasks will cover:
   ```bash
   agentq/agentqctl tasks --epic <epic-id>
   ```

2. For each P0/P1 finding, classify as:
   - **"fix now"**: Genuine issue in current task's scope
   - **"future task (task-id)"**: Will be addressed by a specific upcoming task -- cite the task ID

3. **If ALL P0/P1 findings are "future task"**: Continue to **Step 6** with "Findings to FIX" set to "None." and all items in "Findings to DEFER". After the implementer adds TODO markers, go to **Step 5** for re-review.

4. **If any findings are "fix now"**: Continue to **Step 6** with the triage results attached (both "fix now" and "future task" items in their respective sections).

Append each "future task" item to `DEFERRED_ITEMS` so they carry across review rounds.

### Step 6: Fix Findings -- resume implementer

Resume the implementer via its saved `IMPLEMENT_AGENT_ID`:

```
Task parameters:
  resume: "<IMPLEMENT_AGENT_ID>"
  description: "fix review findings round <REVIEW_ROUND> for <task-id>"
  prompt: |
    The code review found issues that need fixing. You have full context from
    your original implementation. Fix these findings and re-run tests.

    ## Findings to FIX (mandatory)

    These are P0/P1 findings triaged as "fix now" -- genuine issues in this task's scope.

    <FINDINGS CLASSIFIED AS "fix now" from Step 5a triage>

    ## Findings to DEFER (add TODO markers only)

    These findings will be addressed by future tasks. For each one, add a
    `// TODO(task-id): description` comment at the relevant code location.
    Do NOT implement fixes for these -- just add the markers.

    <FINDINGS CLASSIFIED AS "future task (task-id)" from Step 5a triage, or "None." if all are fix-now>

    ## Process
    1. Read each finding carefully
    2. For each "Findings to FIX" P0 finding: fix it. These are mandatory.
    3. For each "Findings to FIX" P1 finding: fix it if the fix is straightforward.
       If a finding is invalid (e.g., flagging intentional project conventions),
       add an explanatory comment at that code location so the reviewer won't
       flag it again.
    4. For each "Findings to DEFER" item: add a `// TODO(task-id): description`
       comment at the relevant code location. Do NOT fix these.
    5. After all fixes + markers, run the test command from the ## Verification
       section of the original task spec
    6. If tests pass:
       "FIX_RESULT: PASS"
    7. If tests fail, fix test failures (max 3 attempts), then:
       - Tests green: "FIX_RESULT: PASS"
       - Tests still broken: "FIX_RESULT: FAIL
         [list each failure with file:line and error]"

    ## Rules
    - You implemented this code. Use your context to make good fixes.
    - Don't blindly apply reviewer suggestions -- understand the intent and
      fix correctly within the codebase context.
    - If a finding is wrong (false positive), add a comment explaining why.
    - Keep fixes minimal. Don't refactor unrelated code.
    - DEFER items get TODO markers ONLY -- do not implement fixes for them.
    - Your FINAL line of output MUST start with FIX_RESULT:
```

**After implementer returns:**
- **Contains "FIX_RESULT: PASS"** -> go back to **Step 5** for another review round.
- **Contains "FIX_RESULT: FAIL"** -> use `AskUserQuestion` to show failures and ask whether to continue to next review round or stop. If stop -> **STOP**. If continue -> go to **Step 5**.

### Step 7: Commit -- spawn auto-commit agent

1. Fetch the task plan to pass to the committer:
   ```bash
   agentq/agentqctl cat <task-id>
   ```
   Extract the `content` field from the JSON output. This is the full task plan text.

2. Spawn a fresh one-shot `general-purpose` Task subagent:

```
Task parameters:
  subagent_type: general-purpose
  description: "auto-commit task <task-id>"
  prompt: |
    Commit the current changes with a well-derived message.

    ## Context
    Task ID: "<TASK_ID>"

    ## Task Plan Content
    <FULL TASK PLAN FROM agentq/agentqctl cat>

    ## Process
    1. Run `git status --short` and `git diff --stat`
    2. If no changes -> respond "SKIP -- nothing to commit" and stop
    <!-- codex-review:known-design -- The committer does not need an explicit
         `git reset` before staging because it stages files selectively by name.
         It runs `git status --short` first, inspects the output, and picks only
         the files relevant to the current task. Pre-staged files from the Step 5
         reviewer may appear in status output but the committer is explicitly
         instructed to stage by name and to never use `git add -A` or `git add .`.
         The "Do NOT stage .env or credential files" rule provides an additional
         safety net against sensitive file leakage. -->
    3. Stage changed files by name: `git add <file1> <file2> ...`
       - Do NOT use `git add -A` or `git add .`
       - Do NOT stage .env or credential files
    4. Derive a conventional commit message from the task plan content above:
       - Format: `<type>: <summary>` (max 72 chars)
       - Types: feat, fix, refactor, test, chore, docs
       - Read the task plan content to understand what the task accomplishes, then write a summary
    5. Commit with HEREDOC:
       ```bash
       git commit -m "$(cat <<'EOF'
       <type>: <summary>

       Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
       EOF
       )"
       ```
    6. Run `git log --oneline -1` to get the commit hash
    7. Respond: "COMMITTED -- <hash> <message>"

    ## Rules
    - Never `git add -A` or `git add .`
    - Never commit .env or credentials
    - No changes -> "SKIP -- nothing to commit"
```

Save the commit hash from the agent's response.

### Step 8: Mark Complete + Loop

1. Build evidence JSON from review data:
   ```json
   {"commit":"<hash>","review":{"rounds":<REVIEW_ROUND>,"codex":"PASS|FAIL","pedant":"PASS|FAIL","architect":"PASS|FAIL","breaker":"PASS|FAIL","result":"PASS|FAIL"}}
   ```
   Where each reviewer field comes from `LAST_REVIEW_DATA`. `result` is `"PASS"` if all 4 passed in the final round, `"FAIL"` otherwise.

2. Mark the task complete in agent-q:
   ```bash
   agentq/agentqctl done <task-id> --summary "<brief description of what was implemented>" --evidence '<evidence JSON>'
   ```

3. Print: `Task <task-id> complete (<commit hash or SKIP>)`

4. **LOOP BACK NOW: Go to Step 1 to pick the next task.** Do NOT stop here. The loop only ends when Step 1 returns `all_tasks_done` or `no_actionable_tasks`.

### Step 9: All Done

When Step 1 finds `reason: "all_tasks_done"`, print a summary:

```
## AQ Work Loop Complete

Epic: <epic-id> (auto-closed)

| Task | Title | Commit |
|------|-------|--------|
| 1-slug.1 | Add X to Y | <hash> |
| 1-slug.2 | Add B to C | <hash> |
| 1-slug.3 | Add D to E | SKIP   |

All N tasks completed.
```

Then display the full task list with evidence:
```bash
agentq/agentqctl tasks --epic <epic-id>
```

## Key Rules

- **ONE TASK AT A TIME** -- Process exactly one task per loop iteration. Never batch, combine, or parallelize tasks -- even if multiple are unblocked. Each task gets its own implement agent, its own review, and its own commit. This is the #1 rule.
- **NEVER SKIP REVIEW** -- The reviewer MUST run after every task implementation, before every commit. No exceptions. The sequence is ALWAYS: Implement -> Review -> (Fix -> Review)* -> Commit.
- **REVIEWER NEVER EDITS CODE** -- The reviewer is purely adversarial. It reads code, runs analysis, and reports findings. It NEVER fixes anything. All code changes go through the implementer.
- **IMPLEMENTER FIXES FINDINGS** -- When the reviewer reports findings, resume the implementer to fix them. The implementer has full context and makes better fixes.
- **NEVER STOP MID-LOOP** -- After completing a task (Step 8), ALWAYS loop back to Step 1. The ONLY valid exit points are `all_tasks_done` and `no_actionable_tasks` from Step 1. Completing one task and stopping is a critical failure.
- **agentq/agentqctl is the source of truth** -- All state lives in `agentq/` files. Use `agentq/agentqctl` commands for every state transition. Never manipulate `agentq/` files directly.
- **Crash recovery is automatic** -- If the session dies, start a new one and run `/aq-work`. The `agentq/agentqctl next` command will return the in_progress or code_review task, and the work loop resumes from the right phase. (The implement agent context is lost on crash, but the task spec has all needed info.)
- **Implement agent is long-lived** -- resumed with `agent_id` for fixing review findings. Maintains full context of what it built.
- **Reviewer is one-shot per round** -- fresh context each round ensures independent assessment.
- **auto-commit is one-shot** -- fresh context, just needs diff + task info.
- **Respect dependencies** -- `agentq/agentqctl next` handles this automatically. Blocked tasks are skipped; tasks with unmet deps wait.
- **Max rounds**: implement agent test-fix = 3 attempts, review loop = 5 rounds, fix-findings test-fix = 3 attempts.
- **Track per-task**: status, commit hash, review evidence -- all recorded via `agentq/agentqctl done --evidence`.
- **Test commands come from the task spec** -- NOT hardcoded. Each task's ## Verification section specifies how to verify it.
- **CHANGELOG is implementer responsibility** -- The implementer updates CHANGELOG.md during implementation, not as a review pre-flight step.
