// WARNING: These tests mutate the AGENTQ_ACTOR env var (process-global).
// Do NOT run with --parallel; tests across files will race on the env var.

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../agentqctl.ts";
import { createTestEpic, createTestTask, finalizeEpic, setupState, withActor } from "./test_support.ts";

describe("e2e: happy path lifecycle", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("agent-alpha");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("completes full epic lifecycle: init -> create -> tasks -> finalize -> work loop -> auto-close", async () => {
    const epicId = "1-build-auth";

    // 1. Init
    await setupState(tempDir);

    // 2. Create epic
    const id = await createTestEpic(tempDir, "Build Auth");
    expect(id).toEqual(epicId);

    // 3. Create 4 tasks with diamond deps: T1 -> T2,T3 -> T4
    const t1 = await createTestTask(tempDir);
    expect(t1).toEqual(`${epicId}.1`);

    const t2 = await createTestTask(tempDir, undefined, [1]);
    expect(t2).toEqual(`${epicId}.2`);

    const t3 = await createTestTask(tempDir, undefined, [1]);
    expect(t3).toEqual(`${epicId}.3`);

    const t4 = await createTestTask(tempDir, undefined, [2, 3]);
    expect(t4).toEqual(`${epicId}.4`);

    // 4. Finalize epic
    await finalizeEpic(tempDir);

    // Verify deps on disk for T4
    const t4Disk = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/${epicId}/4.state.json`,
        "utf-8",
      ),
    );
    expect(t4Disk.dependsOn).toEqual([2, 3]);

    // 5. Verify via list: 1 epic, 4 tasks all "todo"
    const listResult = await dispatch(["list"], tempDir);
    const epics = listResult.epics as Array<Record<string, unknown>>;
    expect(epics.length).toEqual(1);
    const tasks = epics[0].tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toEqual(4);
    for (const task of tasks) {
      expect(task.status).toEqual("todo");
    }

    // 6. Verify via ready: only T1
    const readyResult = await dispatch(["ready", "--epic", epicId], tempDir);
    const readyTasks = readyResult.tasks as Array<Record<string, unknown>>;
    expect(readyTasks.length).toEqual(1);
    expect(readyTasks[0].id).toEqual(`${epicId}.1`);

    // 7. Work on T1: next -> start -> show -> done (with updatedAt check)
    const nextT1 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextT1.status).toEqual("work");
    expect(nextT1.task).toEqual(`${epicId}.1`);
    expect(nextT1.reason).toEqual("ready_task");

    await dispatch(["start", `${epicId}.1`], tempDir);

    const showT1 = await dispatch(["show", `${epicId}.1`], tempDir);
    const showedTask = showT1.task as Record<string, unknown>;
    expect(showedTask.status).toEqual("in_progress");
    expect(showedTask.assignee).toEqual("agent-alpha");

    // Record updatedAt from disk before completing
    const t1DiskBefore = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/${epicId}/1.state.json`,
        "utf-8",
      ),
    );
    const updatedAtBefore = t1DiskBefore.updatedAt as string;

    await dispatch(
      [
        "done",
        `${epicId}.1`,
        "--summary",
        "OAuth configured",
        "--evidence",
        '{"provider":"google"}',
      ],
      tempDir,
    );

    // Verify updatedAt progressed
    const t1DiskAfter = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/${epicId}/1.state.json`,
        "utf-8",
      ),
    );
    const updatedAtAfter = t1DiskAfter.updatedAt as string;
    expect(
      updatedAtAfter >= updatedAtBefore,
    ).toBeTruthy();

    // Verify task is done on disk
    expect(t1DiskAfter.status).toEqual("done");

    // 8. Verify tasks --status done shows only T1; ready shows T2, T3
    const doneTasks = await dispatch([
      "tasks",
      "--epic",
      epicId,
      "--status",
      "done",
    ], tempDir);
    const doneList = doneTasks.tasks as Array<Record<string, unknown>>;
    expect(doneList.length).toEqual(1);
    expect(doneList[0].id).toEqual(`${epicId}.1`);

    const readyAfterT1 = await dispatch(["ready", "--epic", epicId], tempDir);
    const readyAfterT1Tasks = readyAfterT1.tasks as Array<
      Record<string, unknown>
    >;
    expect(readyAfterT1Tasks.length).toEqual(2);
    const readyIds = readyAfterT1Tasks.map((t) => t.id).sort();
    expect(readyIds).toEqual([`${epicId}.2`, `${epicId}.3`]);

    // 9. Work through T2, T3, T4
    // T2
    const nextT2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextT2.status).toEqual("work");
    expect(nextT2.task).toEqual(`${epicId}.2`);
    expect(nextT2.reason).toEqual("ready_task");
    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch(
      [
        "done",
        `${epicId}.2`,
        "--summary",
        "JWT implemented",
        "--evidence",
        '{"alg":"RS256"}',
      ],
      tempDir,
    );

    // T3
    const nextT3 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextT3.status).toEqual("work");
    expect(nextT3.task).toEqual(`${epicId}.3`);
    expect(nextT3.reason).toEqual("ready_task");
    await dispatch(["start", `${epicId}.3`], tempDir);
    await dispatch(
      [
        "done",
        `${epicId}.3`,
        "--summary",
        "Auth tests written",
        "--evidence",
        '{"tests":12}',
      ],
      tempDir,
    );

    // T4
    const nextT4 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextT4.status).toEqual("work");
    expect(nextT4.task).toEqual(`${epicId}.4`);
    expect(nextT4.reason).toEqual("ready_task");
    await dispatch(["start", `${epicId}.4`], tempDir);
    const doneT4 = await dispatch(
      [
        "done",
        `${epicId}.4`,
        "--summary",
        "Integration tests pass",
        "--evidence",
        '{"pass":true}',
      ],
      tempDir,
    );

    // 10. next -> all_tasks_done
    const nextFinal = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextFinal.status).toEqual("none");
    expect(nextFinal.reason).toEqual("all_tasks_done");

    // 11. Verify epic auto-closed by final done
    expect(doneT4.epicClosed).toEqual(true);
    expect(doneT4.epicId).toEqual(epicId);

    // Verify epic on disk
    const epicDisk = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/${epicId}/state.json`,
        "utf-8",
      ),
    );
    expect(epicDisk.status).toEqual("done");

    // 12. Verify summary/evidence in task plan markdown via cat
    const catResult = await dispatch(["cat", `${epicId}.1`], tempDir);
    const specContent = catResult.content as string;
    expect(specContent).toContain("## Done Summary");
    expect(specContent).toContain("OAuth configured");
    expect(specContent).toContain("## Evidence");
    expect(specContent).toContain('"provider": "google"');

    // 13. Verify epic plan readable via cat
    const catEpic = await dispatch(["cat", epicId], tempDir);
    expect(catEpic.content as string).toContain("# Plan: Build Auth");
  });
});
