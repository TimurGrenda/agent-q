# Plan: Schema-version guard for agentq-init

**Created**: 2026-03-14T12:00:00Z
**Status**: Ready for implementation

## Goal

Add a schema-version mechanism so `agentq-init` can safely replace scripts in existing projects when the state format hasn't changed, and refuse to proceed when it has.

## Refined Requirements

- Create a plain-text `schema-version` file at repo root containing `1`
- On fresh install: read schema-version from source, stamp `schemaVersion: 1` into `meta.json`
- On re-run with matching schema: compare source `schema-version` vs `meta.json.schemaVersion`, proceed normally (replace scripts/skills)
- On re-run with mismatch: error with message stating versions + hint to back up, wipe, re-init
- Legacy state (no `schemaVersion` in `meta.json`): treat as version 1, stamp it, proceed
- `MetaData` type gets optional `schemaVersion?: number` field
- Unit tests for all four scenarios

## Implementation Steps

### Step 1: Create schema-version file and update MetaData type

**File**: `schema-version` (new, repo root)
**Action**: create
**Details**: Plain text file containing just `1` with a trailing newline.

**File**: `agentqctl_lib/types.ts` (line 35)
**Action**: modify
**Details**: Add `schemaVersion?: number` to `MetaData` interface.

### Step 2: Add schema-version logic to agentq-init.ts

**File**: `agentq-init.ts` (lines 41-88, section 1-2)
**Action**: modify
**Details**:
1. Read `schema-version` file from sourceDir (alongside deno.json reading)
2. After loading/creating meta.json, compare schema versions:
   - Fresh install (meta was just created): stamp schemaVersion, proceed
   - Existing meta with no schemaVersion: treat as version 1, stamp it
   - Existing meta with matching schemaVersion: proceed
   - Existing meta with mismatching schemaVersion: throw error with hint
3. Always stamp current schemaVersion into meta.json before writing

### Step 3: Add tests for schema-version scenarios

**File**: `tests/agentq_init_test.ts`
**Action**: modify
**Details**: Add test cases for:
- Fresh install stamps schemaVersion in meta.json
- Re-run with same schema-version succeeds and replaces scripts
- Re-run with different schema-version errors
- Legacy state (no schemaVersion) treated as version 1

### Step 4: Update README and CHANGELOG

**File**: `README.md`
**Action**: modify
**Details**: Add `schema-version` to the "What gets created" tree (repo root level). Mention schema-version checking in the description of agentq-init.

**File**: `CHANGELOG.md`
**Action**: modify
**Details**: Add entry under Unreleased > Added for schema-version guard.

## Files Affected

| File | Action | Description |
|------|--------|-------------|
| `schema-version` | create | Plain text file with integer `1` |
| `agentqctl_lib/types.ts` | modify | Add `schemaVersion?: number` to MetaData |
| `agentq-init.ts` | modify | Read schema-version, compare on re-run, error on mismatch |
| `tests/agentq_init_test.ts` | modify | Four new test cases |
| `README.md` | modify | Document schema-version file |
| `CHANGELOG.md` | modify | Add changelog entry |

## Risks & Open Questions

- The schema-version file must be included in distributions/global installs. If someone installs agentq-init globally without the schema-version file, the init will fail. This is acceptable — same as agentqctl.ts being required.

## Testing

- Run `deno task test` to verify all existing + new tests pass
- Manual: run agentq-init on a fresh dir, verify meta.json has schemaVersion
- Manual: run agentq-init again on same dir, verify it succeeds
- Manual: change schema-version to 2, re-run, verify it errors
