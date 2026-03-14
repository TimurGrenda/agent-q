# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- `schema-version` file at repo root (currently `1`) as source of truth for storage format version
- `schemaVersion` optional field in `MetaData` type for tracking schema version in `meta.json`
- `--help` flag and no-args usage output showing all available commands
- Command reference table in aq-plan skill to prevent LLMs from guessing invalid commands
