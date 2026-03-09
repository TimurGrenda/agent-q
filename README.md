# agent-q

Task management for AI coding agents. You describe what to build, the agent plans it, executes it, reviews its own work, and commits — task by task.

All state lives as plain JSON and Markdown files in an `agentq/` directory. Easy to inspect, version-control, and pick up where you left off.

## Why

AI coding agents work better with structure. agent-q gives them a lightweight task tracker so they can break work into pieces, track dependencies, and make steady progress — without you micromanaging each step.

## Installation

Requires [Deno](https://deno.land/). Make sure `~/.deno/bin/` is on your `PATH`.

```bash
# From the agent-q repo:
deno task install
```

This installs `agentq-init` globally. Then, from your project root:

```bash
agentq-init
```

This creates an `agentq/` directory for state and installs two Claude Code skills: `/aq-plan` and `/aq-work`.

## Usage

Everything happens through Claude Code slash commands.

### `/aq-plan` — Plan an epic

Describe what you want to build. The agent asks clarifying questions, explores your codebase, then produces a detailed plan broken into tasks with dependencies.

### `/aq-work` — Execute tasks

The agent picks up the next task, implements it, runs a multi-reviewer code review, fixes any findings, commits, and moves on. Repeat until the epic is done.

You can stop and resume at any time — all state is in files.

### What gets created

```
agentq/
  agentqctl.ts      # CLI entrypoint (copied from agent-q)
  agentqctl_lib/    # Runtime modules
  agentqctl         # Shell wrapper
  deno.json         # Runtime-only import map
  meta.json         # ID counter
  epics/{id}/       # state.json + plan.md per epic
  tasks/{epic-id}/  # N.state.json + N.plan.md per task
  logs/             # Command audit trail
```

## Development

```bash
deno task agentqctl <command> [args]    # run CLI locally (dev mode)
deno task agentq-init                   # run bootstrapper without global install
deno task test                          # run tests
deno task release <major|minor|patch>   # bump version, update CHANGELOG, commit, tag
deno task install-hooks                 # install git pre-push hook
```

`release` requires GNU sed (Linux default; not portable to BSD/macOS sed). The pre-push hook blocks pushes to main unless the commit is at a version tag.

## Inspiration

This project is inspired by [flow-next](https://github.com/gmickel/gmickel-claude-marketplace) by Gordon Mickel — a Claude Code plugin that brings structured planning and task execution to AI-assisted development.

agent-q started as an exercise in understanding how flow-next works by reimplementing its core ideas from scratch: plan first, break work into dependency-tracked tasks, execute task by task with fresh context, and review before committing.

## License

[GNU AGPL v3](LICENSE)
