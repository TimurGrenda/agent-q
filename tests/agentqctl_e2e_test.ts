// WARNING: These tests mutate the AGENTQ_ACTOR env var (process-global).
// Do NOT run with --parallel; tests across files will race on the env var.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dispatch } from "../agentqctl.ts";
import { createTestEpic, createTestTask, finalizeEpic, setupState, withActor } from "./test_support.ts";

describe("e2e: happy path lifecycle", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("agent-alpha");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("completes full epic lifecycle: init -> create -> tasks -> finalize -> work loop -> auto-close", async () => {
    const epicId = "1-build-auth";

    // 1. Init
    await setupState(tempDir);

    // 2. Create epic
    const id = await createTestEpic(tempDir, "Build Auth");
    assertEquals(id, epicId);

    // 3. Create 4 tasks with diamond deps: T1 -> T2,T3 -> T4
    const t1 = await createTestTask(tempDir);
    assertEquals(t1, `${epicId}.1`);

    const t2 = await createTestTask(tempDir, undefined, [1]);
    assertEquals(t2, `${epicId}.2`);

    const t3 = await createTestTask(tempDir, undefined, [1]);
    assertEquals(t3, `${epicId}.3`);

    const t4 = await createTestTask(tempDir, undefined, [2, 3]);
    assertEquals(t4, `${epicId}.4`);

    // 4. Finalize epic
    await finalizeEpic(tempDir);

    // Verify deps on disk for T4
    const t4Disk = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/${epicId}/4.state.json`,
      ),
    );
    assertEquals(t4Disk.dependsOn, [2, 3]);

    // 5. Verify via list: 1 epic, 4 tasks all "todo"
    const listResult = await dispatch(["list"], tempDir);
    const epics = listResult.epics as Array<Record<string, unknown>>;
    assertEquals(epics.length, 1);
    const tasks = epics[0].tasks as Array<Record<string, unknown>>;
    assertEquals(tasks.length, 4);
    for (const task of tasks) {
      assertEquals(task.status, "todo");
    }

    // 6. Verify via ready: only T1
    const readyResult = await dispatch(["ready", "--epic", epicId], tempDir);
    const readyTasks = readyResult.tasks as Array<Record<string, unknown>>;
    assertEquals(readyTasks.length, 1);
    assertEquals(readyTasks[0].id, `${epicId}.1`);

    // 7. Work on T1: next -> start -> show -> done (with updatedAt check)
    const nextT1 = await dispatch(["next", "--epic", epicId], tempDir);
    assertEquals(nextT1.status, "work");
    assertEquals(nextT1.task, `${epicId}.1`);
    assertEquals(nextT1.reason, "ready_task");

    await dispatch(["start", `${epicId}.1`], tempDir);

    const showT1 = await dispatch(["show", `${epicId}.1`], tempDir);
    const showedTask = showT1.task as Record<string, unknown>;
    assertEquals(showedTask.status, "in_progress");
    assertEquals(showedTask.assignee, "agent-alpha");

    // Record updatedAt from disk before completing
    const t1DiskBefore = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/${epicId}/1.state.json`,
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
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/${epicId}/1.state.json`,
      ),
    );
    const updatedAtAfter = t1DiskAfter.updatedAt as string;
    assert(
      updatedAtAfter >= updatedAtBefore,
      "updatedAt should progress after done",
    );

    // Verify task is done on disk
    assertEquals(t1DiskAfter.status, "done");

    // 8. Verify tasks --status done shows only T1; ready shows T2, T3
    const doneTasks = await dispatch([
      "tasks",
      "--epic",
      epicId,
      "--status",
      "done",
    ], tempDir);
    const doneList = doneTasks.tasks as Array<Record<string, unknown>>;
    assertEquals(doneList.length, 1);
    assertEquals(doneList[0].id, `${epicId}.1`);

    const readyAfterT1 = await dispatch(["ready", "--epic", epicId], tempDir);
    const readyAfterT1Tasks = readyAfterT1.tasks as Array<
      Record<string, unknown>
    >;
    assertEquals(readyAfterT1Tasks.length, 2);
    const readyIds = readyAfterT1Tasks.map((t) => t.id).sort();
    assertEquals(readyIds, [`${epicId}.2`, `${epicId}.3`]);

    // 9. Work through T2, T3, T4
    // T2
    const nextT2 = await dispatch(["next", "--epic", epicId], tempDir);
    assertEquals(nextT2.status, "work");
    assertEquals(nextT2.task, `${epicId}.2`);
    assertEquals(nextT2.reason, "ready_task");
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
    assertEquals(nextT3.status, "work");
    assertEquals(nextT3.task, `${epicId}.3`);
    assertEquals(nextT3.reason, "ready_task");
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
    assertEquals(nextT4.status, "work");
    assertEquals(nextT4.task, `${epicId}.4`);
    assertEquals(nextT4.reason, "ready_task");
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
    assertEquals(nextFinal.status, "none");
    assertEquals(nextFinal.reason, "all_tasks_done");

    // 11. Verify epic auto-closed by final done
    assertEquals(doneT4.epicClosed, true);
    assertEquals(doneT4.epicId, epicId);

    // Verify epic on disk
    const epicDisk = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/${epicId}/state.json`,
      ),
    );
    assertEquals(epicDisk.status, "done");

    // 12. Verify summary/evidence in task plan markdown via cat
    const catResult = await dispatch(["cat", `${epicId}.1`], tempDir);
    const specContent = catResult.content as string;
    assertStringIncludes(specContent, "## Done Summary");
    assertStringIncludes(specContent, "OAuth configured");
    assertStringIncludes(specContent, "## Evidence");
    assertStringIncludes(specContent, '"provider": "google"');

    // 13. Verify epic plan readable via cat
    const catEpic = await dispatch(["cat", epicId], tempDir);
    assertStringIncludes(catEpic.content as string, "# Plan: Build Auth");
  });
});
