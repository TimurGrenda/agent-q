// Tests for agentq-init.ts bootstrapper.
// Verifies directory creation, file generation, idempotent re-runs,
// missing skills handling, and integration with dispatch.

import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { runInit } from "../agentq-init.ts";
import { dispatch } from "../agentqctl.ts";
import { withActor } from "./test_support.ts";

const sourceDir = `${import.meta.dirname!}/..`; // agent-q repo root

describe("agentq-init: fresh install", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await Deno.remove(tempDir, { recursive: true });
  });

  it("creates all directories and files", async () => {
    tempDir = await Deno.makeTempDir();
    const result = await runInit(sourceDir, tempDir);

    // Verify result shape
    assertEquals(result.state, "created");
    assertEquals(result.script, "installed");
    assertEquals(result.wrapper, "installed");

    // Verify directories exist (plans/ no longer created — plans live inside epic/task dirs)
    for (const sub of ["epics", "tasks", "logs"]) {
      const stat = await Deno.stat(`${tempDir}/agentq/${sub}`);
      assert(stat.isDirectory);
    }

    // Verify meta.json
    const meta = JSON.parse(
      await Deno.readTextFile(`${tempDir}/agentq/meta.json`),
    );
    assertEquals(meta.nextId, 1);
    assertEquals(meta.schemaVersion, 1);

    // Verify .gitkeep files exist (plans/ no longer created)
    for (const sub of ["epics", "tasks", "logs"]) {
      const stat = await Deno.stat(`${tempDir}/agentq/${sub}/.gitkeep`);
      assert(stat.isFile);
    }

    // Verify agentqctl.ts copied (content matches source)
    const copied = await Deno.readTextFile(`${tempDir}/agentq/agentqctl.ts`);
    const source = await Deno.readTextFile(`${sourceDir}/agentqctl.ts`);
    assertEquals(copied, source);
    const copiedModule = await Deno.readTextFile(
      `${tempDir}/agentq/agentqctl_lib/dispatch.ts`,
    );
    const sourceModule = await Deno.readTextFile(
      `${sourceDir}/agentqctl_lib/dispatch.ts`,
    );
    assertEquals(copiedModule, sourceModule);

    // Verify deno.json generated with runtime-only import map
    const denoJson = JSON.parse(
      await Deno.readTextFile(`${tempDir}/agentq/deno.json`),
    );
    assert(denoJson.imports["@std/cli"]);

    // Verify shell wrapper exists and is executable
    const wrapperStat = await Deno.stat(`${tempDir}/agentq/agentqctl`);
    assert(wrapperStat.isFile);
    // Check executable bits (owner, group, or other)
    assert((wrapperStat.mode! & 0o111) !== 0);

    // Verify skills copied
    for (const skill of ["aq-plan", "aq-work"]) {
      const stat = await Deno.stat(
        `${tempDir}/.claude/skills/${skill}/SKILL.md`,
      );
      assert(stat.isFile);
    }
  });
});

describe("agentq-init: idempotent re-run", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await Deno.remove(tempDir, { recursive: true });
  });

  it("preserves existing meta.json on re-run", async () => {
    tempDir = await Deno.makeTempDir();

    // First run
    await runInit(sourceDir, tempDir);

    // Modify meta.json to simulate usage (nextId advanced to 5)
    await Deno.writeTextFile(
      `${tempDir}/agentq/meta.json`,
      JSON.stringify({ nextId: 5 }, null, 2) + "\n",
    );

    // Second run
    const result = await runInit(sourceDir, tempDir);
    assertEquals(result.state, "exists");

    // meta.json NOT overwritten — nextId preserved, schemaVersion stamped
    const meta = JSON.parse(
      await Deno.readTextFile(`${tempDir}/agentq/meta.json`),
    );
    assertEquals(meta.nextId, 5);
    assertEquals(meta.schemaVersion, 1);
    // Legacy initVersion should be removed
    assertEquals(meta.initVersion, undefined);
  });
});

describe("agentq-init: missing skills directory", () => {
  let tempDir: string;
  let fakeSource: string;

  afterEach(async () => {
    if (tempDir) await Deno.remove(tempDir, { recursive: true });
    if (fakeSource) await Deno.remove(fakeSource, { recursive: true });
  });

  it("succeeds with empty skills when skills dir is missing", async () => {
    tempDir = await Deno.makeTempDir();
    fakeSource = await Deno.makeTempDir();
    // Provide stub files so the copy step succeeds
    await Deno.writeTextFile(`${fakeSource}/agentqctl.ts`, "// stub");
    await Deno.mkdir(`${fakeSource}/agentqctl_lib`, { recursive: true });
    await Deno.writeTextFile(
      `${fakeSource}/agentqctl_lib/dispatch.ts`,
      "// stub module",
    );
    // deno.json is required for version reading
    await Deno.writeTextFile(
      `${fakeSource}/deno.json`,
      JSON.stringify({ version: "0.0.0-test" }, null, 2) + "\n",
    );

    const result = await runInit(fakeSource, tempDir);
    assertEquals(result.skills, {});
  });
});

describe("agentq-init: integration with dispatch", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    if (tempDir) await Deno.remove(tempDir, { recursive: true });
  });

  it("created state is usable by dispatch", async () => {
    tempDir = await Deno.makeTempDir();
    await runInit(sourceDir, tempDir);

    restoreActor = withActor("test-agent");

    // dispatch uses aqDir(root) = `${root}/agentq`, so pass tempDir as root
    // Verify we can create an epic via the new API
    const planFile = `${tempDir}/_tmp_plan.md`;
    await Deno.writeTextFile(planFile, "# Plan: Test Epic\n");
    const result = await dispatch(
      ["epic", "create", "--title", "Test Epic", "--file", planFile],
      tempDir,
    );
    assertEquals(result.id, "1-test-epic");
    assertEquals(result.status, "scaffolding");
  });
});
