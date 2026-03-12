# agent-q

File-based task/epic manager for AI agents. CLI controller (`agentqctl.ts`) plus bootstrapper (`agentq-init.ts`), running on Bun.

## Tech Stack

- **Runtime**: Bun (native TypeScript, no build step)
- **Dependencies**: `minimist` (runtime); `bun-types` (dev)
- **Storage**: Directory-based JSON + Markdown files in `agentq/`

## Project Structure

```
agentqctl.ts              # CLI entrypoint + public API exports
agentqctl_lib/            # Modular core (commands, dispatch, domain, store, utils, logging, types)
agentq-init.ts            # Bootstrapper — sets up a project for agent-q
skills/                   # Source of truth for Claude Code skills (aq-plan, aq-work)
scripts/release.sh        # Semver bump + CHANGELOG update + commit + tag
hooks/pre-push            # Blocks pushes to main unless at a version tag
tests/                    # All test files (agentqctl_test, e2e, scheduler, utils, init)
tests/test_support.ts     # Shared test fixtures/helpers
package.json              # Scripts, dependencies, and version
```

## Running

```bash
bun run agentqctl <command> [args]      # run CLI (in agent-q repo)
bun run agentq-init                     # bootstrap CWD for agent-q
bun test                                # run tests
bun run release <major|minor|patch>     # bump version, update CHANGELOG, commit, tag
bun run install-hooks                   # install git pre-push hook
```

In consuming projects (after `agentq-init` has run):

```bash
agentq/agentqctl <command> [args]      # run CLI via local wrapper
```

## Architecture

- `agentqctl.ts` is the thin entrypoint. Runtime behavior lives in `agentqctl_lib/`.
- `dispatch(args, root)` returns command output JSON; `runCommand(args, root)` returns `{ output, epicId? }` for CLI logging context.
- Command routing is declarative via `COMMANDS` registry in `agentqctl_lib/commands.ts`.
- All output is JSON. No human-readable format.
- Store is directory-based: `agentq/meta.json` (ID counter), `agentq/epics/{id}/` (state.json + plan.md), `agentq/tasks/{epic-id}/` (N.state.json + N.plan.md).
- Tests use temp directories and call `dispatch()` directly — no subprocess spawning.
- `agentq-init.ts` copies `agentqctl.ts` and `agentqctl_lib/` into the target, generates a minimal `package.json` (runtime deps only) and a shell wrapper, and copies skills to `.claude/skills/`.
- In consuming projects, `agentq/agentqctl` (shell wrapper) invokes the local copy of `agentqctl.ts`.

## Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `epic create` | `--title`, `--file` | Create epic in scaffolding state |
| `epic finalize` | `[epic-id]` | Move scaffolding -> open (requires >= 1 task) |
| `task create` | `--title`, `--file`, `[--deps]` | Add task to scaffolding epic |
| `task set-deps` | `<task-id>`, `--deps` | Update task dependencies |
| `start` | `<task-id>` | Assign task to actor, move to in_progress |
| `done` | `<task-id>`, `[--summary]`, `[--evidence]` | Mark task done, auto-close epic if all done |
| `review` | `<task-id>` | Move task to code_review |
| `block` | `<task-id>`, `--reason` | Block a task (assignee-only for assigned tasks) |
| `unblock` | `<task-id>` | Unblock -> todo, clear assignee |
| `ready` | `--epic` | List tasks with all deps met |
| `next` | `--epic` | Scheduler: what should the actor do next |
| `show` | `<id>` | Show epic or task state JSON |
| `cat` | `<id>` | Show epic or task plan markdown |
| `list` | | List all epics with their tasks |
| `tasks` | `--epic`, `[--status]` | List tasks for an epic |

Deps are task numbers within the epic (e.g., `--deps "1,2"`), not full task IDs.

## Key Design Decisions

See `.llm-artefacts/user-decisions.md` for the full list. Highlights:

- **Single epic scope (v1)**: No cross-epic deps or multi-epic scheduling. The current version is "one epic only" — multi-epic scenarios are out of scope and not tested.
- **Auto-slugified epic IDs**: `{N}-{slug}` derived from title. Slug collisions are errors.
- **Actor**: Resolved from `AGENTQ_ACTOR` env var, falling back to `git config user.name`.
- **Task deps**: Same epic only. Validated on create and on `start`.
- **`next` scheduler priority**: own in_progress/code_review → lowest ready task → all done → stuck.

## Skills

Claude Code skills (`aq-work`, `aq-plan`) live in `skills/` in this repo. This is the **source of truth**. `agentq-init` copies them to `.claude/skills/` in the target project. Never edit installed copies directly.

## Conventions

- Public API from `agentqctl.ts`: `dispatch`, `runCommand`.
- Supporting modules in `agentqctl_lib/` are importable for focused tests but not treated as stable consumer API.
- ID formats: epic = `{N}-{slug}`, task = `{epic-id}.{M}`.
- Task statuses: `todo → in_progress → code_review → done` (with `blocked` as a side state).
- Epic statuses: `scaffolding → open → in_progress → done` (auto-closes when all tasks are done).
