// Tests for agentq-init.ts bootstrapper.
// Verifies directory creation, file generation, idempotent re-runs,
// missing skills handling, and integration with dispatch.

import { afterEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../agentq-init.ts";
import { dispatch } from "../agentqctl.ts";
import { withActor } from "./test_support.ts";

const sourceDir = `${import.meta.dirname}/..`; // agent-q repo root

describe("agentq-init: fresh install", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true });
  });

  it("creates all directories and files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    const result = await runInit(sourceDir, tempDir);

    // Verify result shape
    expect(result.state).toEqual("created");
    expect(result.script).toEqual("installed");
    expect(result.wrapper).toEqual("installed");

    // Verify directories exist (plans/ no longer created — plans live inside epic/task dirs)
    for (const sub of ["epics", "tasks", "logs"]) {
      const s = await stat(`${tempDir}/agentq/${sub}`);
      expect(s.isDirectory()).toBeTruthy();
    }

    // Verify meta.json
    const meta = JSON.parse(
      await readFile(`${tempDir}/agentq/meta.json`, "utf-8"),
    );
    expect(meta.nextId).toEqual(1);

    // Verify .gitkeep files exist (plans/ no longer created)
    for (const sub of ["epics", "tasks", "logs"]) {
      const s = await stat(`${tempDir}/agentq/${sub}/.gitkeep`);
      expect(s.isFile()).toBeTruthy();
    }

    // Verify agentqctl.ts copied (content matches source)
    const copied = await readFile(`${tempDir}/agentq/agentqctl.ts`, "utf-8");
    const source = await readFile(`${sourceDir}/agentqctl.ts`, "utf-8");
    expect(copied).toEqual(source);
    const copiedModule = await readFile(
      `${tempDir}/agentq/agentqctl_lib/dispatch.ts`,
      "utf-8",
    );
    const sourceModule = await readFile(
      `${sourceDir}/agentqctl_lib/dispatch.ts`,
      "utf-8",
    );
    expect(copiedModule).toEqual(sourceModule);

    // Verify package.json generated with runtime dependency
    const packageJson = JSON.parse(
      await readFile(`${tempDir}/agentq/package.json`, "utf-8"),
    );
    expect(packageJson.dependencies["minimist"]).toBeTruthy();

    // Verify shell wrapper exists and is executable
    const wrapperStat = await stat(`${tempDir}/agentq/agentqctl`);
    expect(wrapperStat.isFile()).toBeTruthy();
    // Check executable bits (owner, group, or other)
    expect((wrapperStat.mode! & 0o111) !== 0).toBeTruthy();

    // Verify skills copied
    for (const skill of ["aq-plan", "aq-work"]) {
      const s = await stat(
        `${tempDir}/.claude/skills/${skill}/SKILL.md`,
      );
      expect(s.isFile()).toBeTruthy();
    }
  });
});

describe("agentq-init: idempotent re-run", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true });
  });

  it("preserves existing meta.json on re-run", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));

    // First run
    await runInit(sourceDir, tempDir);

    // Modify meta.json to simulate usage (nextId advanced to 5)
    await writeFile(
      `${tempDir}/agentq/meta.json`,
      JSON.stringify({ nextId: 5 }, null, 2) + "\n",
    );

    // Second run
    const result = await runInit(sourceDir, tempDir);
    expect(result.state).toEqual("exists");

    // meta.json NOT overwritten — nextId preserved
    const meta = JSON.parse(
      await readFile(`${tempDir}/agentq/meta.json`, "utf-8"),
    );
    expect(meta.nextId).toEqual(5);
  });
});

describe("agentq-init: missing skills directory", () => {
  let tempDir: string;
  let fakeSource: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true });
    if (fakeSource) await rm(fakeSource, { recursive: true });
  });

  it("succeeds with empty skills when skills dir is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    fakeSource = await mkdtemp(join(tmpdir(), "agentq-"));
    // Provide stub files so the copy step succeeds
    await writeFile(`${fakeSource}/agentqctl.ts`, "// stub");
    await mkdir(`${fakeSource}/agentqctl_lib`, { recursive: true });
    await writeFile(
      `${fakeSource}/agentqctl_lib/dispatch.ts`,
      "// stub module",
    );
    // package.json is required for version reading
    await writeFile(
      `${fakeSource}/package.json`,
      JSON.stringify({ version: "0.0.0-test" }, null, 2) + "\n",
    );

    const result = await runInit(fakeSource, tempDir);
    expect(result.skills).toEqual({});
  });
});

describe("agentq-init: integration with dispatch", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    if (tempDir) await rm(tempDir, { recursive: true });
  });

  it("created state is usable by dispatch", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await runInit(sourceDir, tempDir);

    restoreActor = withActor("test-agent");

    // dispatch uses aqDir(root) = `${root}/agentq`, so pass tempDir as root
    // Verify we can create an epic via the new API
    const planFile = `${tempDir}/_tmp_plan.md`;
    await writeFile(planFile, "# Plan: Test Epic\n");
    const result = await dispatch(
      ["epic", "create", "--title", "Test Epic", "--file", planFile],
      tempDir,
    );
    expect(result.id).toEqual("1-test-epic");
    expect(result.status).toEqual("scaffolding");
  });
});
