// WARNING: These tests mutate the AGENTQ_ACTOR env var (process-global).
// Do NOT run with --parallel; tests across files will race on the env var.

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../agentqctl.ts";
import { createTestEpic, createTestTask, finalizeEpic, setupState, withActor } from "./test_support.ts";

// ── Test 12: Diamond Deps with Scheduler Tie-Breaking ──────────────────────

describe("e2e: diamond deps scheduler tie-breaking", () => {
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

  it("next picks lowest-numbered task when multiple are ready", async () => {
    const epicId = "1-diamond-tie";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Diamond Tie");

    // Diamond: T1 -> T2,T3 -> T4
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [2, 3]);
    await finalizeEpic(tempDir);

    // Only T1 ready initially
    const ready1 = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready1.tasks as Array<Record<string, unknown>>).length).toEqual(1);

    // Complete T1
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // T2 and T3 both ready
    const ready2 = await dispatch(["ready", "--epic", epicId], tempDir);
    const readyIds = (ready2.tasks as Array<Record<string, unknown>>).map((t) =>
      t.id
    ).sort();
    expect(readyIds).toEqual([`${epicId}.2`, `${epicId}.3`]);

    // next picks T2 (lowest number)
    const next1 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next1.task).toEqual(`${epicId}.2`);

    // Complete T2, next picks T3
    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch([
      "done",
      `${epicId}.2`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const next2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next2.task).toEqual(`${epicId}.3`);

    // Complete T3, T4 becomes ready
    await dispatch(["start", `${epicId}.3`], tempDir);
    await dispatch([
      "done",
      `${epicId}.3`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const next3 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next3.task).toEqual(`${epicId}.4`);

    // Complete T4
    await dispatch(["start", `${epicId}.4`], tempDir);
    await dispatch([
      "done",
      `${epicId}.4`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const nextFinal = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextFinal.reason).toEqual("all_tasks_done");
  });
});

// ── Test 13: Multi-Agent with Dependency Handoff ───────────────────────────

describe("e2e: multi-agent dependency handoff", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("alice");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("agent A completing work unblocks agent B through deps", async () => {
    const epicId = "1-handoff";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Handoff");

    // T1 (no deps), T2 (deps T1), T3 (no deps), T4 (deps T2, T3)
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [2, 3]);
    await finalizeEpic(tempDir);

    // Alice takes T1
    process.env["AGENTQ_ACTOR"] = "alice";
    const aliceNext = await dispatch(["next", "--epic", epicId], tempDir);
    expect(aliceNext.task).toEqual(`${epicId}.1`);
    await dispatch(["start", `${epicId}.1`], tempDir);

    // Bob takes T3 (T1 is alice's, T2 has unmet deps)
    process.env["AGENTQ_ACTOR"] = "bob";
    const bobNext = await dispatch(["next", "--epic", epicId], tempDir);
    expect(bobNext.task).toEqual(`${epicId}.3`);
    await dispatch(["start", `${epicId}.3`], tempDir);

    // Bob finishes T3
    await dispatch([
      "done",
      `${epicId}.3`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // Bob has nothing left (T2 blocked by T1 which is alice's, T4 blocked by T2)
    const bobStuck = await dispatch(["next", "--epic", epicId], tempDir);
    expect(bobStuck.reason).toEqual("no_actionable_tasks");

    // Alice finishes T1 -> T2 becomes ready
    process.env["AGENTQ_ACTOR"] = "alice";
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // Bob can now pick up T2
    process.env["AGENTQ_ACTOR"] = "bob";
    const bobNext2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(bobNext2.task).toEqual(`${epicId}.2`);
    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch([
      "done",
      `${epicId}.2`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // T4 is now ready (both T2 and T3 done)
    process.env["AGENTQ_ACTOR"] = "alice";
    const aliceNext2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(aliceNext2.task).toEqual(`${epicId}.4`);
    await dispatch(["start", `${epicId}.4`], tempDir);
    await dispatch([
      "done",
      `${epicId}.4`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    const nextFinal = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextFinal.reason).toEqual("all_tasks_done");
  });
});

// ── Test 14: All Tasks Claimed by Other Agents ─────────────────────────────

describe("e2e: all tasks claimed by others", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("alice");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("third agent gets no_actionable_tasks when all tasks are in_progress", async () => {
    const epicId = "1-all-claimed";
    await setupState(tempDir);
    await createTestEpic(tempDir, "All Claimed");

    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Alice takes T1
    process.env["AGENTQ_ACTOR"] = "alice";
    await dispatch(["start", `${epicId}.1`], tempDir);

    // Bob takes T2
    process.env["AGENTQ_ACTOR"] = "bob";
    await dispatch(["start", `${epicId}.2`], tempDir);

    // Charlie has nothing
    process.env["AGENTQ_ACTOR"] = "charlie";
    const charlieNext = await dispatch(["next", "--epic", epicId], tempDir);
    expect(charlieNext.status).toEqual("none");
    expect(charlieNext.reason).toEqual("no_actionable_tasks");

    // Alice finishes T1 — but no todo tasks remain for charlie
    process.env["AGENTQ_ACTOR"] = "alice";
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // Charlie still gets nothing (T1 done, T2 is bob's)
    process.env["AGENTQ_ACTOR"] = "charlie";
    const charlieNext2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(charlieNext2.reason).toEqual("no_actionable_tasks");

    // Bob finishes T2 -> all done
    process.env["AGENTQ_ACTOR"] = "bob";
    await dispatch([
      "done",
      `${epicId}.2`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    process.env["AGENTQ_ACTOR"] = "charlie";
    const charlieFinal = await dispatch(["next", "--epic", epicId], tempDir);
    expect(charlieFinal.reason).toEqual("all_tasks_done");
  });
});

// ── Test 15: tasks --status blocked filter ─────────────────────────────────

describe("e2e: tasks status filters", () => {
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

  it("filters blocked tasks and all four statuses simultaneously", async () => {
    const epicId = "1-status-filter";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Status Filter");

    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // T1 -> done
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    // T2 -> in_progress
    await dispatch(["start", `${epicId}.2`], tempDir);
    // T3 -> blocked
    await dispatch(["block", `${epicId}.3`, "--reason", "stuck"], tempDir);
    // T4 stays todo

    // Filter by each status
    const done = await dispatch(
      ["tasks", "--epic", epicId, "--status", "done"],
      tempDir,
    );
    expect((done.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (done.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.1`);

    const ip = await dispatch([
      "tasks",
      "--epic",
      epicId,
      "--status",
      "in_progress",
    ], tempDir);
    expect((ip.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (ip.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.2`);

    const blocked = await dispatch([
      "tasks",
      "--epic",
      epicId,
      "--status",
      "blocked",
    ], tempDir);
    expect((blocked.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (blocked.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.3`);

    const todo = await dispatch(
      ["tasks", "--epic", epicId, "--status", "todo"],
      tempDir,
    );
    expect((todo.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (todo.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.4`);

    // Unfiltered returns all 4
    const all = await dispatch(["tasks", "--epic", epicId], tempDir);
    expect((all.tasks as Array<Record<string, unknown>>).length).toEqual(4);
  });
});

// ── Test 16: Spec Content Lifecycle ────────────────────────────────────────

describe("e2e: plan content lifecycle", () => {
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

  it("task plan with extra sections survives done with summary+evidence", async () => {
    const epicId = "1-plan-lifecycle";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Plan Lifecycle");

    // Write a custom task plan with extra sections
    const customPlan = `## Description
Custom task description

## Design Notes
Important design decisions here

## Acceptance
- [ ] It compiles
- [ ] Tests pass

## Done Summary
(Written by \`agentqctl done\`)

## Evidence
(Written by \`agentqctl done\`)

## References
- https://example.com
`;
    await createTestTask(tempDir, customPlan);
    await finalizeEpic(tempDir);

    // Start and complete with summary + evidence
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch(
      [
        "done",
        `${epicId}.1`,
        "--summary",
        "All tests pass",
        "--evidence",
        '{"pass":true}',
      ],
      tempDir,
    );

    // Verify all sections survived
    const cat = await dispatch(["cat", `${epicId}.1`], tempDir);
    const content = cat.content as string;

    // Original sections preserved
    expect(content).toContain("Custom task description");
    expect(content).toContain("Important design decisions here");
    expect(content).toContain("- [ ] It compiles");
    expect(content).toContain("https://example.com");

    // Done sections replaced
    expect(content).toContain("All tests pass");
    expect(content).toContain('"pass": true');
  });

  it("epic plan content is set at create time and readable via cat", async () => {
    await setupState(tempDir);
    await createTestEpic(tempDir, "Plan Read Test", "# Plan v1\n\nOriginal plan\n");

    const cat1 = await dispatch(["cat", "1-plan-read-test"], tempDir);
    expect(cat1.content).toEqual("# Plan v1\n\nOriginal plan\n");
  });
});

// ── Test 17: Blocked Branch in Diamond ─────────────────────────────────────

describe("e2e: blocked branch in diamond", () => {
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

  it("blocked branch prevents convergence task, unblock resolves", async () => {
    const epicId = "1-blocked-diamond";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Blocked Diamond");

    // Diamond: T1 -> T2,T3 -> T4
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [2, 3]);
    await finalizeEpic(tempDir);

    // Complete T1
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // Complete T2 (left branch)
    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch([
      "done",
      `${epicId}.2`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    // Block T3 (right branch)
    await dispatch(
      ["block", `${epicId}.3`, "--reason", "waiting on review"],
      tempDir,
    );

    // T4 can't proceed (needs T3), and T3 is blocked -> stuck
    const ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(0);
    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.reason).toEqual("no_actionable_tasks");

    // Unblock T3 -> it becomes ready
    await dispatch(["unblock", `${epicId}.3`], tempDir);
    const readyAfter = await dispatch(["ready", "--epic", epicId], tempDir);
    expect(
      (readyAfter.tasks as Array<Record<string, unknown>>).length,
    ).toEqual(1);
    expect(
      (readyAfter.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.3`);

    // Complete T3 -> T4 becomes ready
    await dispatch(["start", `${epicId}.3`], tempDir);
    await dispatch([
      "done",
      `${epicId}.3`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const next2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next2.task).toEqual(`${epicId}.4`);

    await dispatch(["start", `${epicId}.4`], tempDir);
    await dispatch([
      "done",
      `${epicId}.4`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const nextFinal = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextFinal.reason).toEqual("all_tasks_done");
  });
});

// ── Test 18: next Priority — Own In-Progress Beats Ready ───────────────────

describe("e2e: next priority own in_progress", () => {
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

  it("returns own in_progress over multiple ready tasks", async () => {
    const epicId = "1-own-ip-prio";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Own IP Prio");

    // 5 independent tasks
    for (let i = 0; i < 5; i++) {
      await createTestTask(tempDir);
    }
    await finalizeEpic(tempDir);

    // Start T3 (not the lowest-numbered)
    await dispatch(["start", `${epicId}.3`], tempDir);

    // next must return T3 with reason "in_progress", not T1
    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.task).toEqual(`${epicId}.3`);
    expect(next.reason).toEqual("in_progress");

    // After completing T3, next returns T1 (lowest ready)
    await dispatch([
      "done",
      `${epicId}.3`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const next2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next2.task).toEqual(`${epicId}.1`);
    expect(next2.reason).toEqual("ready_task");
  });
});

// ── Test 19: Multiple In-Progress for Same Actor ───────────────────────────

describe("e2e: multiple in_progress same actor", () => {
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

  it("actor can start multiple tasks and next returns the first one", async () => {
    const epicId = "1-multi-ip";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Multi IP");

    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start T1 and T2 without completing T1
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch(["start", `${epicId}.2`], tempDir);

    // next returns T1 (first in_progress by task number)
    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.task).toEqual(`${epicId}.1`);
    expect(next.reason).toEqual("in_progress");

    // Complete T1, next returns T2 (now first in_progress)
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const next2 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next2.task).toEqual(`${epicId}.2`);
    expect(next2.reason).toEqual("in_progress");

    // Complete T2, next returns T3 (ready)
    await dispatch([
      "done",
      `${epicId}.2`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const next3 = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next3.task).toEqual(`${epicId}.3`);
    expect(next3.reason).toEqual("ready_task");
  });
});

// ── Test 21: Post-Close Behavior ───────────────────────────────────────────

describe("e2e: post-close behavior", () => {
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

  it("read commands work on auto-closed epic", async () => {
    const epicId = "1-post-close";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Post Close");

    await createTestTask(tempDir);
    await finalizeEpic(tempDir);
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      '{"ok":true}',
    ], tempDir);

    // Read commands still work
    const show = await dispatch(["show", epicId], tempDir);
    expect((show.epic as Record<string, unknown>).status).toEqual("done");

    const cat = await dispatch(["cat", epicId], tempDir);
    expect(cat.content as string).toContain("# Plan: Post Close");

    const catTask = await dispatch(["cat", `${epicId}.1`], tempDir);
    expect(catTask.content as string).toContain("Done");

    const showTask = await dispatch(["show", `${epicId}.1`], tempDir);
    expect((showTask.task as Record<string, unknown>).status).toEqual("done");

    const list = await dispatch(["list"], tempDir);
    expect((list.epics as Array<Record<string, unknown>>).length).toEqual(1);

    const tasks = await dispatch(["tasks", "--epic", epicId], tempDir);
    expect((tasks.tasks as Array<Record<string, unknown>>).length).toEqual(1);

    const ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(0);

    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.reason).toEqual("all_tasks_done");
  });
});

// ── Test 23: Blocked Dep Cascade ───────────────────────────────────────────

describe("e2e: blocked dependency cascade", () => {
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

  it("blocking T1 cascades: T2 and T3 stuck, recovery resolves in order", async () => {
    const epicId = "1-cascade";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Cascade");

    // Linear chain: T1 -> T2 -> T3
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [2]);
    await finalizeEpic(tempDir);

    // Block T1
    await dispatch(["block", `${epicId}.1`, "--reason", "waiting"], tempDir);

    // Nothing is ready
    const ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(0);

    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.reason).toEqual("no_actionable_tasks");

    // Unblock T1 -> only T1 is ready (T2 still depends on T1, T3 on T2)
    await dispatch(["unblock", `${epicId}.1`], tempDir);
    const ready2 = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready2.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (ready2.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.1`);

    // Walk through the chain
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    const ready3 = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready3.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (ready3.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.2`);

    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch([
      "done",
      `${epicId}.2`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);

    const ready4 = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready4.tasks as Array<Record<string, unknown>>).length).toEqual(1);
    expect(
      (ready4.tasks as Array<Record<string, unknown>>)[0].id,
    ).toEqual(`${epicId}.3`);

    await dispatch(["start", `${epicId}.3`], tempDir);
    await dispatch([
      "done",
      `${epicId}.3`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    const nextFinal = await dispatch(["next", "--epic", epicId], tempDir);
    expect(nextFinal.reason).toEqual("all_tasks_done");
  });
});

// ── Test 24: set-deps Clearing and Re-Adding ──────────────────────────────

describe("e2e: set-deps clearing and re-adding", () => {
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

  it("ready reflects each dep change in real time", async () => {
    const epicId = "1-dep-dance";
    await setupState(tempDir);
    await createTestEpic(tempDir, "Dep Dance");

    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // All 3 ready initially
    let ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(3);

    // Add dep: T3 depends on T1
    await dispatch(
      ["task", "set-deps", `${epicId}.3`, "--deps", "1"],
      tempDir,
    );
    ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(2); // T1, T2

    // Clear deps on T3
    await dispatch(["task", "set-deps", `${epicId}.3`, "--deps", ""], tempDir);
    ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(3); // all ready again

    // Add both: T3 depends on T1 and T2
    await dispatch([
      "task",
      "set-deps",
      `${epicId}.3`,
      "--deps",
      "1,2",
    ], tempDir);
    ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(2); // T1, T2

    // Complete T1
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch([
      "done",
      `${epicId}.1`,
      "--summary",
      "Done",
      "--evidence",
      "{}",
    ], tempDir);
    ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(1); // only T2 (T3 still needs T2)

    // Remove T2 dep from T3, only keep T1 dep (which is done)
    await dispatch(
      ["task", "set-deps", `${epicId}.3`, "--deps", "1"],
      tempDir,
    );
    ready = await dispatch(["ready", "--epic", epicId], tempDir);
    const readyIds = (ready.tasks as Array<Record<string, unknown>>).map((t) =>
      t.id
    ).sort();
    expect(readyIds).toEqual([`${epicId}.2`, `${epicId}.3`]);
  });
});

describe("e2e: code_review lifecycle", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(() => {
    restoreActor = withActor("test-agent");
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("completes full lifecycle: init -> start -> review -> done -> auto-close", async () => {
    const epicId = "1-review-flow";

    // Init and create epic with 2 tasks (T2 depends on T1)
    await setupState(tempDir);
    await createTestEpic(tempDir, "Review Flow");
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    // T1: start -> review -> done (code_review -> done)
    await dispatch(["start", `${epicId}.1`], tempDir);

    let show = await dispatch(["show", `${epicId}.1`], tempDir);
    expect((show.task as Record<string, unknown>).status).toEqual("in_progress");

    await dispatch(["review", `${epicId}.1`], tempDir);

    show = await dispatch(["show", `${epicId}.1`], tempDir);
    expect((show.task as Record<string, unknown>).status).toEqual("code_review");

    await dispatch(
      [
        "done",
        `${epicId}.1`,
        "--summary",
        "Reviewed",
        "--evidence",
        '{"review":{"rounds":2,"result":"PASS"}}',
      ],
      tempDir,
    );

    show = await dispatch(["show", `${epicId}.1`], tempDir);
    expect((show.task as Record<string, unknown>).status).toEqual("done");

    // T2 should now be ready (T1 is done)
    const ready = await dispatch(["ready", "--epic", epicId], tempDir);
    expect((ready.tasks as Array<unknown>).length).toEqual(1);

    // T2: start -> review -> block (code_review -> blocked) -> unblock -> start -> review -> done
    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch(["review", `${epicId}.2`], tempDir);
    await dispatch(
      ["block", `${epicId}.2`, "--reason", "critical issue found"],
      tempDir,
    );

    show = await dispatch(["show", `${epicId}.2`], tempDir);
    expect((show.task as Record<string, unknown>).status).toEqual("blocked");

    await dispatch(["unblock", `${epicId}.2`], tempDir);
    await dispatch(["start", `${epicId}.2`], tempDir);
    await dispatch(["review", `${epicId}.2`], tempDir);
    await dispatch(
      ["done", `${epicId}.2`, "--summary", "Fixed and done"],
      tempDir,
    );

    // All done — next should say so
    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.reason).toEqual("all_tasks_done");

    // Epic auto-closed
    const epicDisk = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/${epicId}/state.json`,
        "utf-8",
      ),
    );
    expect(epicDisk.status).toEqual("done");
  });

  it("next returns code_review task at same priority as in_progress", async () => {
    const epicId = "1-review-next";

    await setupState(tempDir);
    await createTestEpic(tempDir, "Review Next");
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start and review T1
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch(["review", `${epicId}.1`], tempDir);

    // Next should return T1 with reason code_review (not T2)
    const next = await dispatch(["next", "--epic", epicId], tempDir);
    expect(next.status).toEqual("work");
    expect(next.task).toEqual(`${epicId}.1`);
    expect(next.reason).toEqual("code_review");
  });

  it("tasks --status code_review filters correctly in e2e flow", async () => {
    const epicId = "1-review-filter";

    await setupState(tempDir);
    await createTestEpic(tempDir, "Review Filter");
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // T1: start + review, T2: start (in_progress), T3: todo
    await dispatch(["start", `${epicId}.1`], tempDir);
    await dispatch(["review", `${epicId}.1`], tempDir);
    await dispatch(["start", `${epicId}.2`], tempDir);

    const reviewTasks = await dispatch(
      ["tasks", "--epic", epicId, "--status", "code_review"],
      tempDir,
    );
    const tasks = reviewTasks.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toEqual(1);
    expect(tasks[0].id).toEqual(`${epicId}.1`);
    expect(tasks[0].status).toEqual("code_review");
  });
});

// ── Scaffolding guard for ready/next ───────────────────────────────────────

describe("e2e: scaffolding guard for ready and next", () => {
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

  it("ready rejects scaffolding epic", async () => {
    await setupState(tempDir);
    const epicId = await createTestEpic(tempDir, "Scaffolding Ready");
    await createTestTask(tempDir);

    // Do NOT finalize — epic is still in scaffolding state
    expect(
      dispatch(["ready", "--epic", epicId], tempDir),
    ).rejects.toThrow("scaffolding");
  });

  it("next rejects scaffolding epic", async () => {
    await setupState(tempDir);
    const epicId = await createTestEpic(tempDir, "Scaffolding Next");
    await createTestTask(tempDir);

    // Do NOT finalize — epic is still in scaffolding state
    expect(
      dispatch(["next", "--epic", epicId], tempDir),
    ).rejects.toThrow("scaffolding");
  });
});
