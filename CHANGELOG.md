# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- `schema-version` file at repo root (currently `1`) as source of truth for storage format version
- `schemaVersion` optional field in `MetaData` type for tracking schema version in `meta.json`
- Schema-version guard in `agentq-init`: reads source `schema-version`, stamps it into `meta.json`, and refuses to overwrite if installed state has a different schema version
- Tests for all four schema-version scenarios: fresh install stamps version, idempotent re-run preserves it, mismatch rejects, legacy state (no schemaVersion) treated as v1
- `--help` flag and no-args usage output showing all available commands
- Command reference table in aq-plan skill to prevent LLMs from guessing invalid commands
