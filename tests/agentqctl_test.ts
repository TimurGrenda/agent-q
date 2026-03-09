import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dispatch } from "../agentqctl.ts";
import { appendLogEntry, formatLogEntry } from "../agentqctl_lib/logging.ts";
import { AgentqStore } from "../agentqctl_lib/store.ts";
import { createTestEpic, createTestTask, finalizeEpic, setupState, withActor } from "./test_support.ts";

describe("epic create", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("creates epic with title and file", async () => {
    const epicId = await createTestEpic(tempDir, "Add User Auth");
    assertEquals(epicId, "1-add-user-auth");

    // Verify state.json on disk
    const epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-add-user-auth/state.json`,
      ),
    );
    assertEquals(epic.status, "scaffolding");
    assertEquals(epic.id, "1-add-user-auth");
  });

  it("copies plan file into epic directory", async () => {
    await createTestEpic(tempDir, "Plan Copy Test");

    const plan = await Deno.readTextFile(
      `${tempDir}/agentq/epics/1-plan-copy-test/plan.md`,
    );
    assertStringIncludes(plan, "# Plan: Plan Copy Test");
  });

  it("allocates epic IDs sequentially", async () => {
    const id1 = await createTestEpic(tempDir, "First");
    // Finalize first epic so second can be created (only one scaffolding at a time)
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const id2 = await createTestEpic(tempDir, "Second");
    assertEquals(id1, "1-first");
    assertEquals(id2, "2-second");
  });

  it("errors when --title is missing", async () => {
    const planFile = `${tempDir}/_tmp.md`;
    await Deno.writeTextFile(planFile, "# Plan\n");
    await assertRejects(
      () => dispatch(["epic", "create", "--file", planFile], tempDir),
      Error,
      "--title is required",
    );
  });

  it("errors when --file is missing", async () => {
    await assertRejects(
      () => dispatch(["epic", "create", "--title", "Test"], tempDir),
      Error,
      "--file is required",
    );
  });

  it("errors on nonexistent file", async () => {
    await assertRejects(
      () =>
        dispatch([
          "epic",
          "create",
          "--title",
          "Test",
          "--file",
          `${tempDir}/nonexistent.md`,
        ], tempDir),
      Error,
      "File not found",
    );
  });

  it("errors when another epic is in scaffolding", async () => {
    await createTestEpic(tempDir, "First Epic");

    const planFile = `${tempDir}/_tmp2.md`;
    await Deno.writeTextFile(planFile, "# Plan 2\n");
    await assertRejects(
      () =>
        dispatch([
          "epic",
          "create",
          "--title",
          "Second Epic",
          "--file",
          planFile,
        ], tempDir),
      Error,
      "already in scaffolding state",
    );
  });

  it("returns scaffolding status in result", async () => {
    const planFile = `${tempDir}/_tmp.md`;
    await Deno.writeTextFile(planFile, "# Plan\n");
    const result = await dispatch(
      ["epic", "create", "--title", "Status Test", "--file", planFile],
      tempDir,
    );
    assertEquals(result.status, "scaffolding");
    assertEquals(result.id, "1-status-test");
  });
});

describe("epic finalize", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("transitions scaffolding epic to open", async () => {
    const epicId = await createTestEpic(tempDir, "Finalize Test");
    await createTestTask(tempDir);
    const result = await dispatch(["epic", "finalize"], tempDir);
    assertEquals(result.id, epicId);
    assertEquals(result.status, "open");

    // Verify on disk
    const epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-finalize-test/state.json`,
      ),
    );
    assertEquals(epic.status, "open");
  });

  it("accepts optional positional epic ID", async () => {
    const epicId = await createTestEpic(tempDir, "Positional Test");
    await createTestTask(tempDir);
    const result = await dispatch(["epic", "finalize", epicId], tempDir);
    assertEquals(result.id, epicId);
    assertEquals(result.status, "open");
  });

  it("errors when epic has no tasks", async () => {
    await createTestEpic(tempDir, "No Tasks");
    await assertRejects(
      () => dispatch(["epic", "finalize"], tempDir),
      Error,
      "has no tasks",
    );
  });

  it("errors when epic is not in scaffolding state", async () => {
    const epicId = await createTestEpic(tempDir, "Already Open");
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await assertRejects(
      () => dispatch(["epic", "finalize", epicId], tempDir),
      Error,
      "not in scaffolding state",
    );
  });

  it("errors when no scaffolding epic exists", async () => {
    await assertRejects(
      () => dispatch(["epic", "finalize"], tempDir),
      Error,
      "No epic in scaffolding state",
    );
  });
});

describe("task create", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
    await createTestEpic(tempDir, "Auth Feature");
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("creates task with correct ID and fields", async () => {
    const taskId = await createTestTask(tempDir);
    assertEquals(taskId, "1-auth-feature.1");

    // Verify state.json on disk
    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-auth-feature/1.state.json`,
      ),
    );
    assertEquals(task.id, "1-auth-feature.1");
    assertEquals(task.epic, "1-auth-feature");
    assertEquals(task.title, "Test task");
    assertEquals(task.status, "todo");
    assertEquals(task.assignee, null);
    assertEquals(task.evidence, null);
    assertEquals(task.blockReason, null);
    assertEquals(task.dependsOn, []);
  });

  it("copies plan file into task directory", async () => {
    await createTestTask(tempDir, "## Custom Task Plan\n\nDetails here.\n");

    const plan = await Deno.readTextFile(
      `${tempDir}/agentq/tasks/1-auth-feature/1.plan.md`,
    );
    assertStringIncludes(plan, "## Custom Task Plan");
  });

  it("allocates incrementing task numbers", async () => {
    const r1 = await createTestTask(tempDir);
    const r2 = await createTestTask(tempDir);
    const r3 = await createTestTask(tempDir);
    assertEquals(r1, "1-auth-feature.1");
    assertEquals(r2, "1-auth-feature.2");
    assertEquals(r3, "1-auth-feature.3");
  });

  it("validates dependencies exist", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");

    await assertRejects(
      () =>
        dispatch(
          ["task", "create", "--title", "Test", "--file", taskFile, "--deps", "99"],
          tempDir,
        ),
      Error,
      "Task not found",
    );
  });

  it("creates task with valid dependencies", async () => {
    await createTestTask(tempDir);
    const taskId = await createTestTask(tempDir, undefined, [1]);
    assertEquals(taskId, "1-auth-feature.2");

    // Verify deps in state.json on disk
    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-auth-feature/2.state.json`,
      ),
    );
    assertEquals(task.dependsOn, [1]);
  });

  it("errors when no scaffolding epic exists", async () => {
    // Finalize the epic so there's no scaffolding epic
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");

    await assertRejects(
      () => dispatch(["task", "create", "--title", "Test", "--file", taskFile], tempDir),
      Error,
      "No epic in scaffolding state",
    );
  });

  it("errors when --file is missing", async () => {
    await assertRejects(
      () => dispatch(["task", "create", "--title", "Test"], tempDir),
      Error,
      "--file is required",
    );
  });

  it("errors when --title is missing", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");
    await assertRejects(
      () => dispatch(["task", "create", "--file", taskFile], tempDir),
      Error,
      "--title is required",
    );
  });

  it("errors on multiline title", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");
    await assertRejects(
      () =>
        dispatch(
          ["task", "create", "--title", "line1\nline2", "--file", taskFile],
          tempDir,
        ),
      Error,
      "Title must be a single line",
    );
  });

  it("errors on whitespace-only title", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");
    await assertRejects(
      () =>
        dispatch(
          ["task", "create", "--title", "   ", "--file", taskFile],
          tempDir,
        ),
      Error,
      "--title must not be blank",
    );
  });

  it("errors on title exceeding 200 characters", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");
    const longTitle = "A".repeat(201);
    await assertRejects(
      () =>
        dispatch(
          ["task", "create", "--title", longTitle, "--file", taskFile],
          tempDir,
        ),
      Error,
      "Title must be 200 characters or fewer",
    );
  });

  it("includes title in task create output", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");
    const result = await dispatch(
      ["task", "create", "--title", "My custom title", "--file", taskFile],
      tempDir,
    );
    assertEquals(result.title, "My custom title");
    assertEquals(result.id, "1-auth-feature.1");
  });
});

describe("task set-deps", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
    await createTestEpic(tempDir, "Deps Epic");
    // Create three tasks
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("replaces existing dependencies", async () => {
    // Set task 3 deps to 1 and 2
    const r1 = await dispatch(
      ["task", "set-deps", "1-deps-epic.3", "--deps", "1,2"],
      tempDir,
    );
    assertEquals(r1.dependsOn, [1, 2]);

    // Verify on disk
    let task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-deps-epic/3.state.json`,
      ),
    );
    assertEquals(task.dependsOn, [1, 2]);

    // Now replace with just task 1
    const r2 = await dispatch(
      ["task", "set-deps", "1-deps-epic.3", "--deps", "1"],
      tempDir,
    );
    assertEquals(r2.dependsOn, [1]);

    // Verify task 2 is gone from deps
    task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-deps-epic/3.state.json`,
      ),
    );
    assertEquals(task.dependsOn, [1]);
  });

  it("rejects self-dependency", async () => {
    await assertRejects(
      () =>
        dispatch(
          ["task", "set-deps", "1-deps-epic.1", "--deps", "1"],
          tempDir,
        ),
      Error,
      "cannot depend on itself",
    );
  });

  it("rejects nonexistent dependency", async () => {
    await assertRejects(
      () =>
        dispatch(
          ["task", "set-deps", "1-deps-epic.1", "--deps", "99"],
          tempDir,
        ),
      Error,
      "Task not found",
    );
  });
});

// ── Workflow command tests ─────────────────────────────────────────────────

describe("start", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Workflow Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("moves task from todo to in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(["start", "1-workflow-epic.1"], tempDir);
    assertEquals(result.id, "1-workflow-epic.1");
    assertEquals(result.title, "Test task");
    assertEquals(result.assignee, "test-agent");

    // Verify on disk
    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-workflow-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "in_progress");
    assertEquals(task.assignee, "test-agent");
  });

  it("transitions epic from open to in_progress on first start", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Verify epic is open before start
    let epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
      ),
    );
    assertEquals(epic.status, "open");

    // Start first task
    await dispatch(["start", "1-workflow-epic.1"], tempDir);

    // Verify epic transitioned to in_progress
    epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
      ),
    );
    assertEquals(epic.status, "in_progress");
  });

  it("does not re-transition epic on subsequent starts", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start first task — epic goes to in_progress
    await dispatch(["start", "1-workflow-epic.1"], tempDir);

    // Record updatedAt
    let epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
      ),
    );
    const firstUpdate = epic.updatedAt;
    assertEquals(epic.status, "in_progress");

    // Complete first, start second — epic should stay in_progress
    await dispatch(["done", "1-workflow-epic.1"], tempDir);
    await dispatch(["start", "1-workflow-epic.2"], tempDir);

    epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
      ),
    );
    assertEquals(epic.status, "in_progress");
    // updatedAt should NOT have changed again for the epic (it stays in_progress)
    assertEquals(epic.updatedAt, firstUpdate);
  });

  it("errors if epic is still in scaffolding", async () => {
    await createTestTask(tempDir);
    // Don't finalize — epic is still scaffolding

    await assertRejects(
      () => dispatch(["start", "1-workflow-epic.1"], tempDir),
      Error,
      "still in scaffolding state",
    );
  });

  it("errors if task is already done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-workflow-epic.1"], tempDir);
    await dispatch(["done", "1-workflow-epic.1"], tempDir);

    await assertRejects(
      () => dispatch(["start", "1-workflow-epic.1"], tempDir),
      Error,
      "already done",
    );
  });

  it("errors if task is already in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-workflow-epic.1"], tempDir);

    await assertRejects(
      () => dispatch(["start", "1-workflow-epic.1"], tempDir),
      Error,
      "already in progress",
    );
  });

  it("errors if task is blocked", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch([
      "block",
      "1-workflow-epic.1",
      "--reason",
      "waiting on API",
    ], tempDir);

    await assertRejects(
      () => dispatch(["start", "1-workflow-epic.1"], tempDir),
      Error,
      "is blocked",
    );
  });

  it("errors if task is in code_review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-workflow-epic.1"], tempDir);
    await dispatch(["review", "1-workflow-epic.1"], tempDir);

    await assertRejects(
      () => dispatch(["start", "1-workflow-epic.1"], tempDir),
      Error,
      "in code review",
    );
  });

  it("errors if dependencies are not met", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    // Task 1 is still todo, so task 2 should fail to start
    await assertRejects(
      () => dispatch(["start", "1-workflow-epic.2"], tempDir),
      Error,
      "unmet dependencies",
    );
  });
});

describe("done", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Done Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("moves task from in_progress to done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result = await dispatch(["done", "1-done-epic.1"], tempDir);
    assertEquals(result.id, "1-done-epic.1");
    assertEquals(result.title, "Test task");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-done-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "done");
  });

  it("writes summary to task plan markdown", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    await dispatch([
      "done",
      "1-done-epic.1",
      "--summary",
      "Implemented OAuth",
    ], tempDir);

    // Verify via cat (reads from the task plan file)
    const cat = await dispatch(["cat", "1-done-epic.1"], tempDir);
    const content = cat.content as string;
    assertStringIncludes(content, "## Done Summary");
    assertStringIncludes(content, "Implemented OAuth");
  });

  it("writes evidence to both JSON and markdown", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    await dispatch(
      ["done", "1-done-epic.1", "--evidence", '{"commits":["abc"]}'],
      tempDir,
    );

    // Verify JSON field
    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-done-epic/1.state.json`,
      ),
    );
    assertEquals(task.evidence, { commits: ["abc"] });

    // Verify markdown via cat
    const cat = await dispatch(["cat", "1-done-epic.1"], tempDir);
    const content = cat.content as string;
    assertStringIncludes(content, "## Evidence");
    assertStringIncludes(content, '"commits"');
    assertStringIncludes(content, "```json");
  });

  it("errors if task is not in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await assertRejects(
      () => dispatch(["done", "1-done-epic.1"], tempDir),
      Error,
      "not in progress",
    );
  });

  it("errors if different actor tries to complete", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start as test-agent
    await dispatch(["start", "1-done-epic.1"], tempDir);

    // Switch actor to bob
    Deno.env.set("AGENTQ_ACTOR", "bob");
    await assertRejects(
      () => dispatch(["done", "1-done-epic.1"], tempDir),
      Error,
      "assigned to test-agent, not bob",
    );
  });

  it("errors on invalid evidence JSON", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);

    await assertRejects(
      () =>
        dispatch(
          ["done", "1-done-epic.1", "--evidence", "not json"],
          tempDir,
        ),
      Error,
      "Invalid evidence JSON",
    );
  });

  it("moves task from code_review to done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    await dispatch(["review", "1-done-epic.1"], tempDir);

    const result = await dispatch(
      [
        "done",
        "1-done-epic.1",
        "--summary",
        "Reviewed and done",
        "--evidence",
        '{"review":"PASS"}',
      ],
      tempDir,
    );
    assertEquals(result.id, "1-done-epic.1");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-done-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "done");
    assertEquals(task.evidence, { review: "PASS" });
  });

  it("appends sections if not in markdown", async () => {
    // Create a task with a custom plan that lacks Done Summary / Evidence sections
    await createTestTask(tempDir, "## Description\n\nCustom description\n");
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    await dispatch(
      [
        "done",
        "1-done-epic.1",
        "--summary",
        "All done",
        "--evidence",
        '{"test":true}',
      ],
      tempDir,
    );

    const cat = await dispatch(["cat", "1-done-epic.1"], tempDir);
    const content = cat.content as string;
    assertStringIncludes(content, "## Done Summary");
    assertStringIncludes(content, "All done");
    assertStringIncludes(content, "## Evidence");
    assertStringIncludes(content, '"test"');
  });

  it("auto-closes epic when last task is done", async () => {
    // Create 2 tasks
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Complete task 1 — epic should stay in_progress
    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result1 = await dispatch(["done", "1-done-epic.1"], tempDir);
    assertEquals(result1.epicClosed, undefined);

    // Complete task 2 — epic should auto-close
    await dispatch(["start", "1-done-epic.2"], tempDir);
    const result2 = await dispatch(["done", "1-done-epic.2"], tempDir);
    assertEquals(result2.epicClosed, true);
    assertEquals(result2.epicId, "1-done-epic");

    // Verify epic on disk
    const epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-done-epic/state.json`,
      ),
    );
    assertEquals(epic.status, "done");
  });

  it("does not close epic when tasks remain undone", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result = await dispatch(["done", "1-done-epic.1"], tempDir);

    // No epicClosed in response
    assertEquals(result.epicClosed, undefined);

    // Epic still in_progress (transitioned from open on first start)
    const epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-done-epic/state.json`,
      ),
    );
    assertEquals(epic.status, "in_progress");
  });

  it("auto-closes single-task epic", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result = await dispatch(["done", "1-done-epic.1"], tempDir);
    assertEquals(result.epicClosed, true);
    assertEquals(result.epicId, "1-done-epic");

    const epic = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/epics/1-done-epic/state.json`,
      ),
    );
    assertEquals(epic.status, "done");
  });
});

describe("review", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Review Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("moves task from in_progress to code_review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);

    const result = await dispatch(["review", "1-review-epic.1"], tempDir);
    assertEquals(result.id, "1-review-epic.1");
    assertEquals(result.status, "code_review");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-review-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "code_review");
  });

  it("preserves assignee", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);
    await dispatch(["review", "1-review-epic.1"], tempDir);

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-review-epic/1.state.json`,
      ),
    );
    assertEquals(task.assignee, "test-agent");
  });

  it("errors if task is not in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await assertRejects(
      () => dispatch(["review", "1-review-epic.1"], tempDir),
      Error,
      "not in progress",
    );
  });

  it("errors if task is already code_review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);
    await dispatch(["review", "1-review-epic.1"], tempDir);

    await assertRejects(
      () => dispatch(["review", "1-review-epic.1"], tempDir),
      Error,
      "not in progress",
    );
  });

  it("errors if task is already done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);
    await dispatch(["done", "1-review-epic.1"], tempDir);

    await assertRejects(
      () => dispatch(["review", "1-review-epic.1"], tempDir),
      Error,
      "not in progress",
    );
  });

  it("errors if different actor tries to review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);

    Deno.env.set("AGENTQ_ACTOR", "bob");
    await assertRejects(
      () => dispatch(["review", "1-review-epic.1"], tempDir),
      Error,
      "assigned to test-agent, not bob",
    );
  });
});

describe("block", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Block Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("blocks a todo task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["block", "1-block-epic.1", "--reason", "waiting on API key"],
      tempDir,
    );
    assertEquals(result.id, "1-block-epic.1");
    assertEquals(result.blockReason, "waiting on API key");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-block-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "blocked");
    assertEquals(task.blockReason, "waiting on API key");
  });

  it("blocks an in_progress task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-block-epic.1"], tempDir);
    const result = await dispatch(
      ["block", "1-block-epic.1", "--reason", "external dependency"],
      tempDir,
    );
    assertEquals(result.blockReason, "external dependency");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-block-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "blocked");
  });

  it("blocks a code_review task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-block-epic.1"], tempDir);
    await dispatch(["review", "1-block-epic.1"], tempDir);

    const result = await dispatch(
      ["block", "1-block-epic.1", "--reason", "review found critical issue"],
      tempDir,
    );
    assertEquals(result.blockReason, "review found critical issue");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-block-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "blocked");
  });

  it("errors if task is already done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-block-epic.1"], tempDir);
    await dispatch(["done", "1-block-epic.1"], tempDir);

    await assertRejects(
      () =>
        dispatch(
          ["block", "1-block-epic.1", "--reason", "too late"],
          tempDir,
        ),
      Error,
      "already done",
    );
  });

  it("errors if task is already blocked", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(
      ["block", "1-block-epic.1", "--reason", "reason 1"],
      tempDir,
    );

    await assertRejects(
      () =>
        dispatch(
          ["block", "1-block-epic.1", "--reason", "reason 2"],
          tempDir,
        ),
      Error,
      "already blocked",
    );
  });

  it("errors without --reason", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await assertRejects(
      () => dispatch(["block", "1-block-epic.1"], tempDir),
      Error,
      "--reason is required",
    );
  });

  it("errors if different actor tries to block assigned task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start the task as test-agent (assigns it)
    await dispatch(["start", "1-block-epic.1"], tempDir);

    // Switch to a different actor
    const restoreOther = withActor("other-agent");
    try {
      await assertRejects(
        () =>
          dispatch(
            ["block", "1-block-epic.1", "--reason", "stealing block"],
            tempDir,
          ),
        Error,
        "assigned to test-agent, not other-agent",
      );
    } finally {
      restoreOther();
    }
  });

  it("allows any actor to block unassigned todo task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Task is todo with no assignee — switch to a different actor
    const restoreOther = withActor("other-agent");
    try {
      const result = await dispatch(
        ["block", "1-block-epic.1", "--reason", "needs clarification"],
        tempDir,
      );
      assertEquals(result.id, "1-block-epic.1");
      assertEquals(result.blockReason, "needs clarification");
    } finally {
      restoreOther();
    }
  });
});

describe("unblock", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Unblock Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("unblocks to todo, clears assignee and blockReason", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start it (gives it an assignee), then block it
    await dispatch(["start", "1-unblock-epic.1"], tempDir);
    await dispatch(
      ["block", "1-unblock-epic.1", "--reason", "waiting"],
      tempDir,
    );

    const result = await dispatch(["unblock", "1-unblock-epic.1"], tempDir);
    assertEquals(result.id, "1-unblock-epic.1");
    assertEquals(result.status, "todo");

    const task = JSON.parse(
      await Deno.readTextFile(
        `${tempDir}/agentq/tasks/1-unblock-epic/1.state.json`,
      ),
    );
    assertEquals(task.status, "todo");
    assertEquals(task.assignee, null);
    assertEquals(task.blockReason, null);
  });

  it("errors if task is not blocked", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await assertRejects(
      () => dispatch(["unblock", "1-unblock-epic.1"], tempDir),
      Error,
      "not blocked",
    );
  });
});

// ── Scheduler command tests ────────────────────────────────────────────────

describe("ready", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Ready Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("lists tasks with no deps and status todo", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["ready", "--epic", "1-ready-epic"],
      tempDir,
    );
    const tasks = result.tasks as { id: string; title: string }[];
    assertEquals(tasks.length, 3);
    assertEquals(tasks[0].id, "1-ready-epic.1");
    assertEquals(tasks[0].title, "Test task");
    assertEquals(tasks[1].id, "1-ready-epic.2");
    assertEquals(tasks[2].id, "1-ready-epic.3");
  });

  it("excludes tasks with unmet deps", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["ready", "--epic", "1-ready-epic"],
      tempDir,
    );
    const tasks = result.tasks as { id: string; title: string }[];
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].id, "1-ready-epic.1");
  });

  it("includes tasks whose deps are all done", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    // Complete task 1
    await dispatch(["start", "1-ready-epic.1"], tempDir);
    await dispatch(["done", "1-ready-epic.1"], tempDir);

    const result = await dispatch(
      ["ready", "--epic", "1-ready-epic"],
      tempDir,
    );
    const tasks = result.tasks as { id: string; title: string }[];
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].id, "1-ready-epic.2");
  });

  it("excludes blocked, in_progress, and done tasks", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start task 2 (in_progress)
    await dispatch(["start", "1-ready-epic.2"], tempDir);
    // Complete task 3
    await dispatch(["start", "1-ready-epic.3"], tempDir);
    await dispatch(["done", "1-ready-epic.3"], tempDir);
    // Block task 4
    await dispatch(
      ["block", "1-ready-epic.4", "--reason", "waiting"],
      tempDir,
    );

    const result = await dispatch(
      ["ready", "--epic", "1-ready-epic"],
      tempDir,
    );
    const tasks = result.tasks as { id: string; title: string }[];
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].id, "1-ready-epic.1");
  });

  it("returns empty array when no tasks are ready", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(
      ["block", "1-ready-epic.1", "--reason", "waiting"],
      tempDir,
    );
    await dispatch(["start", "1-ready-epic.2"], tempDir);

    const result = await dispatch(
      ["ready", "--epic", "1-ready-epic"],
      tempDir,
    );
    const tasks = result.tasks as { id: string; title: string }[];
    assertEquals(tasks.length, 0);
  });
});

describe("next", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Next Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("returns own in_progress task first", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start task 1 (makes it in_progress for test-agent)
    await dispatch(["start", "1-next-epic.1"], tempDir);

    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "work");
    assertEquals(result.epic, "1-next-epic");
    assertEquals(result.task, "1-next-epic.1");
    assertEquals(result.title, "Test task");
    assertEquals(result.reason, "in_progress");
  });

  it("returns own code_review task first", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start and review task 1
    await dispatch(["start", "1-next-epic.1"], tempDir);
    await dispatch(["review", "1-next-epic.1"], tempDir);

    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "work");
    assertEquals(result.task, "1-next-epic.1");
    assertEquals(result.title, "Test task");
    assertEquals(result.reason, "code_review");
  });

  it("skips others' code_review tasks", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start and review task 1 as alice
    Deno.env.set("AGENTQ_ACTOR", "alice");
    await dispatch(["start", "1-next-epic.1"], tempDir);
    await dispatch(["review", "1-next-epic.1"], tempDir);

    // Query next as bob — should skip task 1, pick task 2
    Deno.env.set("AGENTQ_ACTOR", "bob");
    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "work");
    assertEquals(result.task, "1-next-epic.2");
    assertEquals(result.title, "Test task");
    assertEquals(result.reason, "ready_task");
  });

  it("returns lowest ready task when nothing in_progress", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "work");
    assertEquals(result.task, "1-next-epic.1");
    assertEquals(result.title, "Test task");
    assertEquals(result.reason, "ready_task");
  });

  it("skips others' in_progress tasks", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start task 1 as "alice"
    Deno.env.set("AGENTQ_ACTOR", "alice");
    await dispatch(["start", "1-next-epic.1"], tempDir);

    // Query next as "bob" — should skip task 1, pick task 2
    Deno.env.set("AGENTQ_ACTOR", "bob");
    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "work");
    assertEquals(result.task, "1-next-epic.2");
    assertEquals(result.title, "Test task");
    assertEquals(result.reason, "ready_task");
  });

  it("returns all_tasks_done when everything is done", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Complete both tasks
    await dispatch(["start", "1-next-epic.1"], tempDir);
    await dispatch(["done", "1-next-epic.1"], tempDir);
    await dispatch(["start", "1-next-epic.2"], tempDir);
    await dispatch(["done", "1-next-epic.2"], tempDir);

    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "none");
    assertEquals(result.epic, "1-next-epic");
    assertEquals(result.task, null);
    assertEquals(result.reason, "all_tasks_done");
  });

  it("returns no_actionable_tasks when stuck", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    // Block task 1 — task 2 has unmet deps, so nothing is actionable
    await dispatch(
      ["block", "1-next-epic.1", "--reason", "waiting"],
      tempDir,
    );

    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "none");
    assertEquals(result.task, null);
    assertEquals(result.reason, "no_actionable_tasks");
  });

  it("returns no_actionable_tasks for epic with no tasks", async () => {
    // Need to finalize to have a valid (non-scaffolding) epic — but finalize requires tasks.
    // Instead, create a task, finalize, then query next.
    // Actually, the ready/next commands work on any epic regardless of scaffolding.
    // But we need a finalized epic. Let's create tasks first then finalize, then make them all blocked.
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Block the only task so nothing is actionable
    await dispatch(
      ["block", "1-next-epic.1", "--reason", "waiting"],
      tempDir,
    );

    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    assertEquals(result.status, "none");
    assertEquals(result.task, null);
    assertEquals(result.reason, "no_actionable_tasks");
  });

  it("respects dependency chains", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [2]);
    await finalizeEpic(tempDir);

    // Next should pick task 1 (only ready task)
    let result = await dispatch(["next", "--epic", "1-next-epic"], tempDir);
    assertEquals(result.task, "1-next-epic.1");
    assertEquals(result.reason, "ready_task");

    // Complete task 1 -> task 2 becomes ready
    await dispatch(["start", "1-next-epic.1"], tempDir);
    await dispatch(["done", "1-next-epic.1"], tempDir);

    result = await dispatch(["next", "--epic", "1-next-epic"], tempDir);
    assertEquals(result.task, "1-next-epic.2");
    assertEquals(result.reason, "ready_task");

    // Complete task 2 -> task 3 becomes ready
    await dispatch(["start", "1-next-epic.2"], tempDir);
    await dispatch(["done", "1-next-epic.2"], tempDir);

    result = await dispatch(["next", "--epic", "1-next-epic"], tempDir);
    assertEquals(result.task, "1-next-epic.3");
    assertEquals(result.reason, "ready_task");
  });
});

// ── Display command tests ──────────────────────────────────────────────────

describe("show", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Show Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("shows epic details", async () => {
    const result = await dispatch(["show", "1-show-epic"], tempDir);
    const epic = result.epic as Record<string, unknown>;
    assertEquals(epic.id, "1-show-epic");
    assertEquals(epic.status, "scaffolding");
    assertEquals(typeof epic.createdAt, "string");
    assertEquals(typeof epic.updatedAt, "string");
  });

  it("shows task details", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(["show", "1-show-epic.1"], tempDir);
    const task = result.task as Record<string, unknown>;
    assertEquals(task.id, "1-show-epic.1");
    assertEquals(task.epic, "1-show-epic");
    assertEquals(task.title, "Test task");
    assertEquals(task.status, "todo");
    assertEquals(task.assignee, null);
    assertEquals(task.evidence, null);
    assertEquals(task.blockReason, null);
    assertEquals(task.dependsOn, []);
  });

  it("errors on invalid ID format", async () => {
    await assertRejects(
      () => dispatch(["show", "not-an-id"], tempDir),
      Error,
      "Invalid ID format",
    );
  });

  it("errors on nonexistent epic", async () => {
    await assertRejects(
      () => dispatch(["show", "99-nonexistent"], tempDir),
      Error,
      "Epic not found",
    );
  });

  it("errors on nonexistent task", async () => {
    await assertRejects(
      () => dispatch(["show", "1-show-epic.99"], tempDir),
      Error,
      "Task not found",
    );
  });
});

describe("cat", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
    await createTestEpic(tempDir, "Cat Epic");
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("returns epic plan content", async () => {
    const result = await dispatch(["cat", "1-cat-epic"], tempDir);
    assertStringIncludes(result.content as string, "# Plan: Cat Epic");
  });

  it("returns task plan markdown", async () => {
    await createTestTask(tempDir);

    const result = await dispatch(["cat", "1-cat-epic.1"], tempDir);
    const content = result.content as string;
    assertStringIncludes(content, "## Description");
    assertStringIncludes(content, "## Acceptance");
  });

  it("errors on nonexistent epic", async () => {
    await assertRejects(
      () => dispatch(["cat", "99-nonexistent"], tempDir),
      Error,
      "Epic not found",
    );
  });

  it("errors on invalid ID format", async () => {
    await assertRejects(
      () => dispatch(["cat", "not-an-id"], tempDir),
      Error,
      "Invalid ID format",
    );
  });
});

describe("list", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("returns all epics with their tasks", async () => {
    // Create first epic with tasks, finalize, then create second
    await createTestEpic(tempDir, "Epic One");
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await createTestEpic(tempDir, "Epic Two");
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(["list"], tempDir);
    const epics = result.epics as Array<Record<string, unknown>>;
    assertEquals(epics.length, 2);
    assertEquals(epics[0].id, "1-epic-one");
    assertEquals(epics[1].id, "2-epic-two");

    const tasks1 = epics[0].tasks as Array<Record<string, unknown>>;
    assertEquals(tasks1.length, 2);
    assertEquals(tasks1[0].id, "1-epic-one.1");
    assertEquals(tasks1[1].id, "1-epic-one.2");

    const tasks2 = epics[1].tasks as Array<Record<string, unknown>>;
    assertEquals(tasks2.length, 1);
    assertEquals(tasks2[0].id, "2-epic-two.1");
  });

  it("returns empty array when no epics exist", async () => {
    const result = await dispatch(["list"], tempDir);
    const epics = result.epics as Array<Record<string, unknown>>;
    assertEquals(epics.length, 0);
  });

  it("includes task summary fields", async () => {
    await createTestEpic(tempDir, "Field Epic");
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-field-epic.1"], tempDir);

    const result = await dispatch(["list"], tempDir);
    const epics = result.epics as Array<Record<string, unknown>>;
    const tasks = epics[0].tasks as Array<Record<string, unknown>>;
    const task = tasks[0];

    assertEquals(task.id, "1-field-epic.1");
    assertEquals(task.title, "Test task");
    assertEquals(task.status, "in_progress");
    assertEquals(task.assignee, "test-agent");
    // Should NOT include full task fields like evidence, blockReason, etc.
    assertEquals("evidence" in task, false);
    assertEquals("blockReason" in task, false);
  });
});

describe("tasks", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Tasks Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("lists all tasks for an epic", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["tasks", "--epic", "1-tasks-epic"],
      tempDir,
    );
    const tasks = result.tasks as Array<Record<string, unknown>>;
    assertEquals(tasks.length, 3);
    assertEquals(tasks[0].id, "1-tasks-epic.1");
    assertEquals(tasks[1].id, "1-tasks-epic.2");
    assertEquals(tasks[2].id, "1-tasks-epic.3");
  });

  it("filters by status", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start task 2
    await dispatch(["start", "1-tasks-epic.2"], tempDir);

    const result = await dispatch(
      ["tasks", "--epic", "1-tasks-epic", "--status", "in_progress"],
      tempDir,
    );
    const tasks = result.tasks as Array<Record<string, unknown>>;
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].id, "1-tasks-epic.2");
    assertEquals(tasks[0].status, "in_progress");
  });

  it("filters by code_review status", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-tasks-epic.1"], tempDir);
    await dispatch(["review", "1-tasks-epic.1"], tempDir);

    const result = await dispatch(
      ["tasks", "--epic", "1-tasks-epic", "--status", "code_review"],
      tempDir,
    );
    const tasks = result.tasks as Array<Record<string, unknown>>;
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].id, "1-tasks-epic.1");
    assertEquals(tasks[0].status, "code_review");
  });

  it("returns empty array when no tasks match filter", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["tasks", "--epic", "1-tasks-epic", "--status", "done"],
      tempDir,
    );
    const tasks = result.tasks as Array<Record<string, unknown>>;
    assertEquals(tasks.length, 0);
  });

  it("errors on invalid status filter", async () => {
    await assertRejects(
      () =>
        dispatch(
          ["tasks", "--epic", "1-tasks-epic", "--status", "invalid"],
          tempDir,
        ),
      Error,
      "Invalid status",
    );
  });

  it("errors on nonexistent epic", async () => {
    await assertRejects(
      () => dispatch(["tasks", "--epic", "99-nonexistent"], tempDir),
      Error,
      "Epic not found",
    );
  });

  it("includes dependsOn and title in task output", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["tasks", "--epic", "1-tasks-epic"],
      tempDir,
    );
    const tasks = result.tasks as Array<Record<string, unknown>>;
    assertEquals(tasks[0].dependsOn, []);
    assertEquals(tasks[0].title, "Test task");
    assertEquals(tasks[1].dependsOn, [1]);
    assertEquals(tasks[1].title, "Test task");
  });
});

describe("formatLogEntry", () => {
  it("produces correct markdown structure", () => {
    const entry = formatLogEntry(
      "2026-03-03T12:00:00.000Z",
      ["epic", "create", "--title", "Test", "--file", "/tmp/plan.md"],
      { success: true, id: "1-test" },
    );
    assertStringIncludes(entry, "### 2026-03-03T12:00:00.000Z");
    assertStringIncludes(entry, "epic create --title Test --file /tmp/plan.md");
    assertStringIncludes(entry, "```json");
    assertStringIncludes(entry, '"success": true');
    assertStringIncludes(entry, '"id": "1-test"');
  });

  it("quotes args containing spaces", () => {
    const entry = formatLogEntry(
      "2026-03-03T12:00:00.000Z",
      ["epic", "create", "--title", "A task with spaces"],
      { success: true },
    );
    assertStringIncludes(entry, '"A task with spaces"');
  });

  it("formats error results", () => {
    const entry = formatLogEntry(
      "2026-03-03T12:00:00.000Z",
      ["start", "1-foo.99"],
      { success: false, error: "Task not found: 1-foo.99" },
    );
    assertStringIncludes(entry, '"success": false');
    assertStringIncludes(entry, "Task not found");
  });
});

describe("appendLogEntry", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("writes to global.md for epic-less commands", async () => {
    const store = new AgentqStore(tempDir);
    await appendLogEntry(store, ["list"], { success: true, epics: [] });
    const content = await Deno.readTextFile(`${tempDir}/agentq/logs/global.md`);
    assertStringIncludes(content, "list");
    assertStringIncludes(content, '"success": true');
  });

  it("writes to epic log file for epic-scoped commands", async () => {
    // Create an epic first
    const epicId = await createTestEpic(tempDir, "Log Test");

    // Log a command against the epic, passing epicId directly
    const store = new AgentqStore(tempDir);
    await appendLogEntry(
      store,
      ["ready", "--epic", epicId],
      { success: true, tasks: [] },
      epicId,
    );

    // Find the epic log file
    const files = [];
    for await (const entry of Deno.readDir(`${tempDir}/agentq/logs`)) {
      if (entry.name.endsWith(`${epicId}.md`)) files.push(entry.name);
    }
    assertEquals(files.length, 1);

    const content = await Deno.readTextFile(
      `${tempDir}/agentq/logs/${files[0]}`,
    );
    assertStringIncludes(content, `ready --epic ${epicId}`);
  });

  it("appends to existing log file", async () => {
    const store = new AgentqStore(tempDir);
    await appendLogEntry(store, ["list"], { success: true, epics: [] });
    await appendLogEntry(store, ["list"], {
      success: true,
      epics: [{ id: "1-x" }],
    });

    const content = await Deno.readTextFile(`${tempDir}/agentq/logs/global.md`);
    const headings = content.split("\n").filter((l: string) =>
      l.startsWith("### ")
    );
    assertEquals(headings.length, 2);
  });

  it("falls back to global log when epic does not exist", async () => {
    const store = new AgentqStore(tempDir);
    await appendLogEntry(
      store,
      ["show", "999-nonexistent"],
      { success: false, error: "Epic not found" },
      "999-nonexistent",
    );
    const content = await Deno.readTextFile(`${tempDir}/agentq/logs/global.md`);
    assertStringIncludes(content, "show 999-nonexistent");
  });
});

describe("dispatch error paths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("rejects unknown command", async () => {
    await assertRejects(
      () => dispatch(["foobar"], tempDir),
      Error,
      "Unknown command: foobar",
    );
  });

  it("rejects empty args", async () => {
    await assertRejects(
      () => dispatch([], tempDir),
      Error,
      "Unknown command: undefined",
    );
  });

  it("rejects unknown epic subcommand", async () => {
    await assertRejects(
      () => dispatch(["epic", "foobar"], tempDir),
      Error,
      "Unknown epic subcommand: foobar",
    );
  });

  it("rejects unknown task subcommand", async () => {
    await assertRejects(
      () => dispatch(["task", "foobar"], tempDir),
      Error,
      "Unknown task subcommand: foobar",
    );
  });
});

describe("command arg validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("task set-deps rejects missing --deps", async () => {
    // Create epic and task so the ID validation passes
    await createTestEpic(tempDir, "Deps Test");
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await assertRejects(
      () => dispatch(["task", "set-deps", "1-deps-test.1"], tempDir),
      Error,
      "--deps is required",
    );
  });
});

describe("output shape", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
    restoreActor = withActor("test-agent");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("does not leak internal _epic field in command outputs", async () => {
    const planFile = `${tempDir}/_tmp.md`;
    await Deno.writeTextFile(planFile, "# Plan\n");
    const epic = await dispatch(
      ["epic", "create", "--title", "Output Shape", "--file", planFile],
      tempDir,
    );
    const epicId = epic.id as string;

    const taskFile = `${tempDir}/_tmp_task.md`;
    await Deno.writeTextFile(taskFile, "## Task\n");
    const task = await dispatch(
      ["task", "create", "--title", "Test", "--file", taskFile],
      tempDir,
    );
    const taskId = task.id as string;

    await dispatch(["epic", "finalize"], tempDir);

    const responses = [
      epic,
      task,
      await dispatch(["show", epicId], tempDir),
      await dispatch(["start", taskId], tempDir),
      await dispatch(["done", taskId], tempDir),
      await dispatch(["tasks", "--epic", epicId], tempDir),
    ];

    for (const response of responses) {
      assertEquals(
        Object.prototype.hasOwnProperty.call(response, "_epic"),
        false,
      );
    }
  });
});

describe("loadMeta corruption", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("rejects corrupt meta.json", async () => {
    // Write invalid JSON to meta.json
    await Deno.writeTextFile(
      `${tempDir}/agentq/meta.json`,
      "{not valid json!!!",
    );

    const planFile = `${tempDir}/_tmp.md`;
    await Deno.writeTextFile(planFile, "# Plan\n");
    await assertRejects(
      () =>
        dispatch(
          ["epic", "create", "--title", "Anything", "--file", planFile],
          tempDir,
        ),
      Error,
      "meta.json not found or corrupt",
    );
  });

  it("rejects missing meta.json", async () => {
    // Delete meta.json
    await Deno.remove(`${tempDir}/agentq/meta.json`);

    const planFile = `${tempDir}/_tmp.md`;
    await Deno.writeTextFile(planFile, "# Plan\n");
    await assertRejects(
      () =>
        dispatch(
          ["epic", "create", "--title", "Anything", "--file", planFile],
          tempDir,
        ),
      Error,
      "meta.json not found or corrupt",
    );
  });
});

describe("task set-deps clearing", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("clears deps with empty string", async () => {
    await createTestEpic(tempDir, "Clear Deps");

    // Create two tasks where T2 depends on T1
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    // Verify T2 has the dependency
    const before = await dispatch(["show", "1-clear-deps.2"], tempDir);
    const taskBefore = before.task as Record<string, unknown>;
    assertEquals(taskBefore.dependsOn, [1]);

    // Clear deps with empty string
    await dispatch(["task", "set-deps", "1-clear-deps.2", "--deps", ""], tempDir);

    // Verify deps are now empty
    const after = await dispatch(["show", "1-clear-deps.2"], tempDir);
    const taskAfter = after.task as Record<string, unknown>;
    assertEquals(taskAfter.dependsOn, []);
  });
});

describe("block preserves assignee", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await Deno.remove(tempDir, { recursive: true });
  });

  it("preserves assignee when blocking in_progress task", async () => {
    await createTestEpic(tempDir, "Block Assign");

    // Create and start a task (assigns to AGENTQ_ACTOR = "test-agent")
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-block-assign.1"], tempDir);

    // Block the task
    await dispatch([
      "block",
      "1-block-assign.1",
      "--reason",
      "waiting on external API",
    ], tempDir);

    // Verify the blocked task still has the original assignee
    const result = await dispatch(["show", "1-block-assign.1"], tempDir);
    const task = result.task as Record<string, unknown>;
    assertEquals(task.status, "blocked");
    assertEquals(task.assignee, "test-agent");
    assertEquals(task.blockReason, "waiting on external API");
  });
});

describe("corrupt state handling", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("loadEpic reports corrupt JSON, not 'not found'", async () => {
    const epicDir = `${tempDir}/agentq/epics/1-broken`;
    await Deno.mkdir(epicDir, { recursive: true });
    await Deno.writeTextFile(`${epicDir}/state.json`, "{invalid json");

    const store = new AgentqStore(tempDir);
    await assertRejects(
      () => store.loadEpic("1-broken"),
      Error,
      "corrupt",
    );
  });

  it("loadTask reports corrupt JSON, not 'not found'", async () => {
    const taskDir = `${tempDir}/agentq/tasks/1-broken`;
    await Deno.mkdir(taskDir, { recursive: true });
    await Deno.writeTextFile(`${taskDir}/1.state.json`, "{bad");

    const store = new AgentqStore(tempDir);
    await assertRejects(
      () => store.loadTask("1-broken.1"),
      Error,
      "corrupt",
    );
  });

  it("loadEpic still reports 'not found' for missing files", async () => {
    const store = new AgentqStore(tempDir);
    await assertRejects(
      () => store.loadEpic("99-nonexistent"),
      Error,
      "not found",
    );
  });
});

describe("backward compat: task without title field", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("loadTask defaults missing title to '(untitled)'", async () => {
    // Write a task state.json that lacks the title field (pre-title schema)
    const taskDir = `${tempDir}/agentq/tasks/1-old-epic`;
    await Deno.mkdir(taskDir, { recursive: true });
    await Deno.writeTextFile(
      `${taskDir}/1.state.json`,
      JSON.stringify({
        id: "1-old-epic.1",
        epic: "1-old-epic",
        status: "todo",
        dependsOn: [],
        assignee: null,
        evidence: null,
        blockReason: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }, null, 2) + "\n",
    );

    const store = new AgentqStore(tempDir);
    const task = await store.loadTask("1-old-epic.1");
    assertEquals(task.title, "(untitled)");
  });

  it("loadAllTasks defaults missing title to '(untitled)'", async () => {
    const taskDir = `${tempDir}/agentq/tasks/1-old-epic`;
    await Deno.mkdir(taskDir, { recursive: true });
    await Deno.writeTextFile(
      `${taskDir}/1.state.json`,
      JSON.stringify({
        id: "1-old-epic.1",
        epic: "1-old-epic",
        status: "todo",
        dependsOn: [],
        assignee: null,
        evidence: null,
        blockReason: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }, null, 2) + "\n",
    );

    const store = new AgentqStore(tempDir);
    const tasks = await store.loadAllTasks("1-old-epic");
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].title, "(untitled)");
  });

  it("loadTask defaults non-string title to '(untitled)'", async () => {
    // Corrupted file with title as array — truthy but not a string
    const taskDir = `${tempDir}/agentq/tasks/1-old-epic`;
    await Deno.mkdir(taskDir, { recursive: true });
    await Deno.writeTextFile(
      `${taskDir}/1.state.json`,
      JSON.stringify({
        id: "1-old-epic.1",
        epic: "1-old-epic",
        title: [],
        status: "todo",
        dependsOn: [],
        assignee: null,
        evidence: null,
        blockReason: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }, null, 2) + "\n",
    );

    const store = new AgentqStore(tempDir);
    const task = await store.loadTask("1-old-epic.1");
    assertEquals(task.title, "(untitled)");
  });
});

describe("task set-deps on done task", () => {
  let tempDir: string;
  let restoreActor: () => void;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    await setupState(tempDir);
    restoreActor = withActor("test-agent");
    await createTestEpic(tempDir, "Done Guard");
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);
    // Complete task 1
    await dispatch(["start", "1-done-guard.1"], tempDir);
    await dispatch(["done", "1-done-guard.1"], tempDir);
  });

  afterEach(async () => {
    restoreActor();
    await Deno.remove(tempDir, { recursive: true });
  });

  it("rejects set-deps on a completed task", async () => {
    await assertRejects(
      () =>
        dispatch(
          ["task", "set-deps", "1-done-guard.1", "--deps", "2"],
          tempDir,
        ),
      Error,
      "Cannot modify deps of a completed task",
    );
  });
});
