import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../agentqctl.ts";
import { appendLogEntry, formatLogEntry } from "../agentqctl_lib/logging.ts";
import { AgentqStore } from "../agentqctl_lib/store.ts";
import { createTestEpic, createTestTask, finalizeEpic, setupState, withActor } from "./test_support.ts";

describe("epic create", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates epic with title and file", async () => {
    const epicId = await createTestEpic(tempDir, "Add User Auth");
    expect(epicId).toEqual("1-add-user-auth");

    // Verify state.json on disk
    const epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-add-user-auth/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("scaffolding");
    expect(epic.id).toEqual("1-add-user-auth");
  });

  it("copies plan file into epic directory", async () => {
    await createTestEpic(tempDir, "Plan Copy Test");

    const plan = await readFile(
      `${tempDir}/agentq/epics/1-plan-copy-test/plan.md`,
      "utf-8",
    );
    expect(plan).toContain("# Plan: Plan Copy Test");
  });

  it("allocates epic IDs sequentially", async () => {
    const id1 = await createTestEpic(tempDir, "First");
    // Finalize first epic so second can be created (only one scaffolding at a time)
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const id2 = await createTestEpic(tempDir, "Second");
    expect(id1).toEqual("1-first");
    expect(id2).toEqual("2-second");
  });

  it("errors when --title is missing", async () => {
    const planFile = `${tempDir}/_tmp.md`;
    await writeFile(planFile, "# Plan\n");
    await expect(dispatch(["epic", "create", "--file", planFile], tempDir)).rejects.toThrow("--title is required");
  });

  it("errors when --file is missing", async () => {
    await expect(dispatch(["epic", "create", "--title", "Test"], tempDir)).rejects.toThrow("--file is required");
  });

  it("errors on nonexistent file", async () => {
    await expect(dispatch([
          "epic",
          "create",
          "--title",
          "Test",
          "--file",
          `${tempDir}/nonexistent.md`,
        ], tempDir)).rejects.toThrow("File not found");
  });

  it("errors when another epic is in scaffolding", async () => {
    await createTestEpic(tempDir, "First Epic");

    const planFile = `${tempDir}/_tmp2.md`;
    await writeFile(planFile, "# Plan 2\n");
    await expect(dispatch([
          "epic",
          "create",
          "--title",
          "Second Epic",
          "--file",
          planFile,
        ], tempDir)).rejects.toThrow("already in scaffolding state");
  });

  it("returns scaffolding status in result", async () => {
    const planFile = `${tempDir}/_tmp.md`;
    await writeFile(planFile, "# Plan\n");
    const result = await dispatch(
      ["epic", "create", "--title", "Status Test", "--file", planFile],
      tempDir,
    );
    expect(result.status).toEqual("scaffolding");
    expect(result.id).toEqual("1-status-test");
  });
});

describe("epic finalize", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("transitions scaffolding epic to open", async () => {
    const epicId = await createTestEpic(tempDir, "Finalize Test");
    await createTestTask(tempDir);
    const result = await dispatch(["epic", "finalize"], tempDir);
    expect(result.id).toEqual(epicId);
    expect(result.status).toEqual("open");

    // Verify on disk
    const epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-finalize-test/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("open");
  });

  it("accepts optional positional epic ID", async () => {
    const epicId = await createTestEpic(tempDir, "Positional Test");
    await createTestTask(tempDir);
    const result = await dispatch(["epic", "finalize", epicId], tempDir);
    expect(result.id).toEqual(epicId);
    expect(result.status).toEqual("open");
  });

  it("errors when epic has no tasks", async () => {
    await createTestEpic(tempDir, "No Tasks");
    await expect(dispatch(["epic", "finalize"], tempDir)).rejects.toThrow("has no tasks");
  });

  it("errors when epic is not in scaffolding state", async () => {
    const epicId = await createTestEpic(tempDir, "Already Open");
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await expect(dispatch(["epic", "finalize", epicId], tempDir)).rejects.toThrow("not in scaffolding state");
  });

  it("errors when no scaffolding epic exists", async () => {
    await expect(dispatch(["epic", "finalize"], tempDir)).rejects.toThrow("No epic in scaffolding state");
  });
});

describe("task create", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
    await createTestEpic(tempDir, "Auth Feature");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates task with correct ID and fields", async () => {
    const taskId = await createTestTask(tempDir);
    expect(taskId).toEqual("1-auth-feature.1");

    // Verify state.json on disk
    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-auth-feature/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.id).toEqual("1-auth-feature.1");
    expect(task.epic).toEqual("1-auth-feature");
    expect(task.title).toEqual("Test task");
    expect(task.status).toEqual("todo");
    expect(task.assignee).toEqual(null);
    expect(task.evidence).toEqual(null);
    expect(task.blockReason).toEqual(null);
    expect(task.dependsOn).toEqual([]);
  });

  it("copies plan file into task directory", async () => {
    await createTestTask(tempDir, "## Custom Task Plan\n\nDetails here.\n");

    const plan = await readFile(
      `${tempDir}/agentq/tasks/1-auth-feature/1.plan.md`,
      "utf-8",
    );
    expect(plan).toContain("## Custom Task Plan");
  });

  it("allocates incrementing task numbers", async () => {
    const r1 = await createTestTask(tempDir);
    const r2 = await createTestTask(tempDir);
    const r3 = await createTestTask(tempDir);
    expect(r1).toEqual("1-auth-feature.1");
    expect(r2).toEqual("1-auth-feature.2");
    expect(r3).toEqual("1-auth-feature.3");
  });

  it("validates dependencies exist", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");

    await expect(dispatch(
          ["task", "create", "--title", "Test", "--file", taskFile, "--deps", "99"],
          tempDir,
        )).rejects.toThrow("Task not found");
  });

  it("creates task with valid dependencies", async () => {
    await createTestTask(tempDir);
    const taskId = await createTestTask(tempDir, undefined, [1]);
    expect(taskId).toEqual("1-auth-feature.2");

    // Verify deps in state.json on disk
    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-auth-feature/2.state.json`,
        "utf-8",
      ),
    );
    expect(task.dependsOn).toEqual([1]);
  });

  it("errors when no scaffolding epic exists", async () => {
    // Finalize the epic so there's no scaffolding epic
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");

    await expect(dispatch(["task", "create", "--title", "Test", "--file", taskFile], tempDir)).rejects.toThrow("No epic in scaffolding state");
  });

  it("errors when --file is missing", async () => {
    await expect(dispatch(["task", "create", "--title", "Test"], tempDir)).rejects.toThrow("--file is required");
  });

  it("errors when --title is missing", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");
    await expect(dispatch(["task", "create", "--file", taskFile], tempDir)).rejects.toThrow("--title is required");
  });

  it("errors on multiline title", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");
    await expect(dispatch(
          ["task", "create", "--title", "line1\nline2", "--file", taskFile],
          tempDir,
        )).rejects.toThrow("Title must be a single line");
  });

  it("errors on whitespace-only title", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");
    await expect(dispatch(
          ["task", "create", "--title", "   ", "--file", taskFile],
          tempDir,
        )).rejects.toThrow("--title must not be blank");
  });

  it("errors on title exceeding 200 characters", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");
    const longTitle = "A".repeat(201);
    await expect(dispatch(
          ["task", "create", "--title", longTitle, "--file", taskFile],
          tempDir,
        )).rejects.toThrow("Title must be 200 characters or fewer");
  });

  it("includes title in task create output", async () => {
    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");
    const result = await dispatch(
      ["task", "create", "--title", "My custom title", "--file", taskFile],
      tempDir,
    );
    expect(result.title).toEqual("My custom title");
    expect(result.id).toEqual("1-auth-feature.1");
  });
});

describe("task set-deps", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
    await createTestEpic(tempDir, "Deps Epic");
    // Create three tasks
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("replaces existing dependencies", async () => {
    // Set task 3 deps to 1 and 2
    const r1 = await dispatch(
      ["task", "set-deps", "1-deps-epic.3", "--deps", "1,2"],
      tempDir,
    );
    expect(r1.dependsOn).toEqual([1, 2]);

    // Verify on disk
    let task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-deps-epic/3.state.json`,
        "utf-8",
      ),
    );
    expect(task.dependsOn).toEqual([1, 2]);

    // Now replace with just task 1
    const r2 = await dispatch(
      ["task", "set-deps", "1-deps-epic.3", "--deps", "1"],
      tempDir,
    );
    expect(r2.dependsOn).toEqual([1]);

    // Verify task 2 is gone from deps
    task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-deps-epic/3.state.json`,
        "utf-8",
      ),
    );
    expect(task.dependsOn).toEqual([1]);
  });

  it("rejects self-dependency", async () => {
    await expect(dispatch(
          ["task", "set-deps", "1-deps-epic.1", "--deps", "1"],
          tempDir,
        )).rejects.toThrow("cannot depend on itself");
  });

  it("rejects nonexistent dependency", async () => {
    await expect(dispatch(
          ["task", "set-deps", "1-deps-epic.1", "--deps", "99"],
          tempDir,
        )).rejects.toThrow("Task not found");
  });
});

// ── Workflow command tests ─────────────────────────────────────────────────

describe("start", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Workflow Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("moves task from todo to in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(["start", "1-workflow-epic.1"], tempDir);
    expect(result.id).toEqual("1-workflow-epic.1");
    expect(result.title).toEqual("Test task");
    expect(result.assignee).toEqual("test-agent");

    // Verify on disk
    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-workflow-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("in_progress");
    expect(task.assignee).toEqual("test-agent");
  });

  it("transitions epic from open to in_progress on first start", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Verify epic is open before start
    let epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("open");

    // Start first task
    await dispatch(["start", "1-workflow-epic.1"], tempDir);

    // Verify epic transitioned to in_progress
    epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("in_progress");
  });

  it("does not re-transition epic on subsequent starts", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start first task — epic goes to in_progress
    await dispatch(["start", "1-workflow-epic.1"], tempDir);

    // Record updatedAt
    let epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
        "utf-8",
      ),
    );
    const firstUpdate = epic.updatedAt;
    expect(epic.status).toEqual("in_progress");

    // Complete first, start second — epic should stay in_progress
    await dispatch(["done", "1-workflow-epic.1"], tempDir);
    await dispatch(["start", "1-workflow-epic.2"], tempDir);

    epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-workflow-epic/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("in_progress");
    // updatedAt should NOT have changed again for the epic (it stays in_progress)
    expect(epic.updatedAt).toEqual(firstUpdate);
  });

  it("errors if epic is still in scaffolding", async () => {
    await createTestTask(tempDir);
    // Don't finalize — epic is still scaffolding

    await expect(dispatch(["start", "1-workflow-epic.1"], tempDir)).rejects.toThrow("still in scaffolding state");
  });

  it("errors if task is already done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-workflow-epic.1"], tempDir);
    await dispatch(["done", "1-workflow-epic.1"], tempDir);

    await expect(dispatch(["start", "1-workflow-epic.1"], tempDir)).rejects.toThrow("already done");
  });

  it("errors if task is already in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-workflow-epic.1"], tempDir);

    await expect(dispatch(["start", "1-workflow-epic.1"], tempDir)).rejects.toThrow("already in progress");
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

    await expect(dispatch(["start", "1-workflow-epic.1"], tempDir)).rejects.toThrow("is blocked");
  });

  it("errors if task is in code_review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-workflow-epic.1"], tempDir);
    await dispatch(["review", "1-workflow-epic.1"], tempDir);

    await expect(dispatch(["start", "1-workflow-epic.1"], tempDir)).rejects.toThrow("in code review");
  });

  it("errors if dependencies are not met", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await finalizeEpic(tempDir);

    // Task 1 is still todo, so task 2 should fail to start
    await expect(dispatch(["start", "1-workflow-epic.2"], tempDir)).rejects.toThrow("unmet dependencies");
  });
});

describe("done", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Done Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("moves task from in_progress to done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result = await dispatch(["done", "1-done-epic.1"], tempDir);
    expect(result.id).toEqual("1-done-epic.1");
    expect(result.title).toEqual("Test task");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-done-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("done");
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
    expect(content).toContain("## Done Summary");
    expect(content).toContain("Implemented OAuth");
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
      await readFile(
        `${tempDir}/agentq/tasks/1-done-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.evidence).toEqual({ commits: ["abc"] });

    // Verify markdown via cat
    const cat = await dispatch(["cat", "1-done-epic.1"], tempDir);
    const content = cat.content as string;
    expect(content).toContain("## Evidence");
    expect(content).toContain('"commits"');
    expect(content).toContain("```json");
  });

  it("errors if task is not in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await expect(dispatch(["done", "1-done-epic.1"], tempDir)).rejects.toThrow("not in progress");
  });

  it("errors if different actor tries to complete", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start as test-agent
    await dispatch(["start", "1-done-epic.1"], tempDir);

    // Switch actor to bob
    process.env["AGENTQ_ACTOR"] = "bob";
    await expect(dispatch(["done", "1-done-epic.1"], tempDir)).rejects.toThrow("assigned to test-agent, not bob");
  });

  it("errors on invalid evidence JSON", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);

    await expect(dispatch(
          ["done", "1-done-epic.1", "--evidence", "not json"],
          tempDir,
        )).rejects.toThrow("Invalid evidence JSON");
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
    expect(result.id).toEqual("1-done-epic.1");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-done-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("done");
    expect(task.evidence).toEqual({ review: "PASS" });
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
    expect(content).toContain("## Done Summary");
    expect(content).toContain("All done");
    expect(content).toContain("## Evidence");
    expect(content).toContain('"test"');
  });

  it("auto-closes epic when last task is done", async () => {
    // Create 2 tasks
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Complete task 1 — epic should stay in_progress
    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result1 = await dispatch(["done", "1-done-epic.1"], tempDir);
    expect(result1.epicClosed).toEqual(undefined);

    // Complete task 2 — epic should auto-close
    await dispatch(["start", "1-done-epic.2"], tempDir);
    const result2 = await dispatch(["done", "1-done-epic.2"], tempDir);
    expect(result2.epicClosed).toEqual(true);
    expect(result2.epicId).toEqual("1-done-epic");

    // Verify epic on disk
    const epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-done-epic/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("done");
  });

  it("does not close epic when tasks remain undone", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result = await dispatch(["done", "1-done-epic.1"], tempDir);

    // No epicClosed in response
    expect(result.epicClosed).toEqual(undefined);

    // Epic still in_progress (transitioned from open on first start)
    const epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-done-epic/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("in_progress");
  });

  it("auto-closes single-task epic", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-done-epic.1"], tempDir);
    const result = await dispatch(["done", "1-done-epic.1"], tempDir);
    expect(result.epicClosed).toEqual(true);
    expect(result.epicId).toEqual("1-done-epic");

    const epic = JSON.parse(
      await readFile(
        `${tempDir}/agentq/epics/1-done-epic/state.json`,
        "utf-8",
      ),
    );
    expect(epic.status).toEqual("done");
  });
});

describe("review", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Review Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("moves task from in_progress to code_review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);

    const result = await dispatch(["review", "1-review-epic.1"], tempDir);
    expect(result.id).toEqual("1-review-epic.1");
    expect(result.status).toEqual("code_review");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-review-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("code_review");
  });

  it("preserves assignee", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);
    await dispatch(["review", "1-review-epic.1"], tempDir);

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-review-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.assignee).toEqual("test-agent");
  });

  it("errors if task is not in_progress", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await expect(dispatch(["review", "1-review-epic.1"], tempDir)).rejects.toThrow("not in progress");
  });

  it("errors if task is already code_review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);
    await dispatch(["review", "1-review-epic.1"], tempDir);

    await expect(dispatch(["review", "1-review-epic.1"], tempDir)).rejects.toThrow("not in progress");
  });

  it("errors if task is already done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);
    await dispatch(["done", "1-review-epic.1"], tempDir);

    await expect(dispatch(["review", "1-review-epic.1"], tempDir)).rejects.toThrow("not in progress");
  });

  it("errors if different actor tries to review", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-review-epic.1"], tempDir);

    process.env["AGENTQ_ACTOR"] = "bob";
    await expect(dispatch(["review", "1-review-epic.1"], tempDir)).rejects.toThrow("assigned to test-agent, not bob");
  });
});

describe("block", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Block Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("blocks a todo task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["block", "1-block-epic.1", "--reason", "waiting on API key"],
      tempDir,
    );
    expect(result.id).toEqual("1-block-epic.1");
    expect(result.blockReason).toEqual("waiting on API key");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-block-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("blocked");
    expect(task.blockReason).toEqual("waiting on API key");
  });

  it("blocks an in_progress task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-block-epic.1"], tempDir);
    const result = await dispatch(
      ["block", "1-block-epic.1", "--reason", "external dependency"],
      tempDir,
    );
    expect(result.blockReason).toEqual("external dependency");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-block-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("blocked");
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
    expect(result.blockReason).toEqual("review found critical issue");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-block-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("blocked");
  });

  it("errors if task is already done", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(["start", "1-block-epic.1"], tempDir);
    await dispatch(["done", "1-block-epic.1"], tempDir);

    await expect(dispatch(
          ["block", "1-block-epic.1", "--reason", "too late"],
          tempDir,
        )).rejects.toThrow("already done");
  });

  it("errors if task is already blocked", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await dispatch(
      ["block", "1-block-epic.1", "--reason", "reason 1"],
      tempDir,
    );

    await expect(dispatch(
          ["block", "1-block-epic.1", "--reason", "reason 2"],
          tempDir,
        )).rejects.toThrow("already blocked");
  });

  it("errors without --reason", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await expect(dispatch(["block", "1-block-epic.1"], tempDir)).rejects.toThrow("--reason is required");
  });

  it("errors if different actor tries to block assigned task", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start the task as test-agent (assigns it)
    await dispatch(["start", "1-block-epic.1"], tempDir);

    // Switch to a different actor
    const restoreOther = withActor("other-agent");
    try {
      await expect(dispatch(
            ["block", "1-block-epic.1", "--reason", "stealing block"],
            tempDir,
          )).rejects.toThrow("assigned to test-agent, not other-agent");
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
      expect(result.id).toEqual("1-block-epic.1");
      expect(result.blockReason).toEqual("needs clarification");
    } finally {
      restoreOther();
    }
  });
});

describe("unblock", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Unblock Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(result.id).toEqual("1-unblock-epic.1");
    expect(result.status).toEqual("todo");

    const task = JSON.parse(
      await readFile(
        `${tempDir}/agentq/tasks/1-unblock-epic/1.state.json`,
        "utf-8",
      ),
    );
    expect(task.status).toEqual("todo");
    expect(task.assignee).toEqual(null);
    expect(task.blockReason).toEqual(null);
  });

  it("errors if task is not blocked", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await expect(dispatch(["unblock", "1-unblock-epic.1"], tempDir)).rejects.toThrow("not blocked");
  });
});

// ── Scheduler command tests ────────────────────────────────────────────────

describe("ready", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Ready Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(tasks.length).toEqual(3);
    expect(tasks[0].id).toEqual("1-ready-epic.1");
    expect(tasks[0].title).toEqual("Test task");
    expect(tasks[1].id).toEqual("1-ready-epic.2");
    expect(tasks[2].id).toEqual("1-ready-epic.3");
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
    expect(tasks.length).toEqual(1);
    expect(tasks[0].id).toEqual("1-ready-epic.1");
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
    expect(tasks.length).toEqual(1);
    expect(tasks[0].id).toEqual("1-ready-epic.2");
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
    expect(tasks.length).toEqual(1);
    expect(tasks[0].id).toEqual("1-ready-epic.1");
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
    expect(tasks.length).toEqual(0);
  });
});

describe("next", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Next Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(result.status).toEqual("work");
    expect(result.epic).toEqual("1-next-epic");
    expect(result.task).toEqual("1-next-epic.1");
    expect(result.title).toEqual("Test task");
    expect(result.reason).toEqual("in_progress");
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
    expect(result.status).toEqual("work");
    expect(result.task).toEqual("1-next-epic.1");
    expect(result.title).toEqual("Test task");
    expect(result.reason).toEqual("code_review");
  });

  it("skips others' code_review tasks", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start and review task 1 as alice
    process.env["AGENTQ_ACTOR"] = "alice";
    await dispatch(["start", "1-next-epic.1"], tempDir);
    await dispatch(["review", "1-next-epic.1"], tempDir);

    // Query next as bob — should skip task 1, pick task 2
    process.env["AGENTQ_ACTOR"] = "bob";
    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    expect(result.status).toEqual("work");
    expect(result.task).toEqual("1-next-epic.2");
    expect(result.title).toEqual("Test task");
    expect(result.reason).toEqual("ready_task");
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
    expect(result.status).toEqual("work");
    expect(result.task).toEqual("1-next-epic.1");
    expect(result.title).toEqual("Test task");
    expect(result.reason).toEqual("ready_task");
  });

  it("skips others' in_progress tasks", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    // Start task 1 as "alice"
    process.env["AGENTQ_ACTOR"] = "alice";
    await dispatch(["start", "1-next-epic.1"], tempDir);

    // Query next as "bob" — should skip task 1, pick task 2
    process.env["AGENTQ_ACTOR"] = "bob";
    const result = await dispatch(
      ["next", "--epic", "1-next-epic"],
      tempDir,
    );
    expect(result.status).toEqual("work");
    expect(result.task).toEqual("1-next-epic.2");
    expect(result.title).toEqual("Test task");
    expect(result.reason).toEqual("ready_task");
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
    expect(result.status).toEqual("none");
    expect(result.epic).toEqual("1-next-epic");
    expect(result.task).toEqual(null);
    expect(result.reason).toEqual("all_tasks_done");
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
    expect(result.status).toEqual("none");
    expect(result.task).toEqual(null);
    expect(result.reason).toEqual("no_actionable_tasks");
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
    expect(result.status).toEqual("none");
    expect(result.task).toEqual(null);
    expect(result.reason).toEqual("no_actionable_tasks");
  });

  it("respects dependency chains", async () => {
    await createTestTask(tempDir);
    await createTestTask(tempDir, undefined, [1]);
    await createTestTask(tempDir, undefined, [2]);
    await finalizeEpic(tempDir);

    // Next should pick task 1 (only ready task)
    let result = await dispatch(["next", "--epic", "1-next-epic"], tempDir);
    expect(result.task).toEqual("1-next-epic.1");
    expect(result.reason).toEqual("ready_task");

    // Complete task 1 -> task 2 becomes ready
    await dispatch(["start", "1-next-epic.1"], tempDir);
    await dispatch(["done", "1-next-epic.1"], tempDir);

    result = await dispatch(["next", "--epic", "1-next-epic"], tempDir);
    expect(result.task).toEqual("1-next-epic.2");
    expect(result.reason).toEqual("ready_task");

    // Complete task 2 -> task 3 becomes ready
    await dispatch(["start", "1-next-epic.2"], tempDir);
    await dispatch(["done", "1-next-epic.2"], tempDir);

    result = await dispatch(["next", "--epic", "1-next-epic"], tempDir);
    expect(result.task).toEqual("1-next-epic.3");
    expect(result.reason).toEqual("ready_task");
  });
});

// ── Display command tests ──────────────────────────────────────────────────

describe("show", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Show Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("shows epic details", async () => {
    const result = await dispatch(["show", "1-show-epic"], tempDir);
    const epic = result.epic as Record<string, unknown>;
    expect(epic.id).toEqual("1-show-epic");
    expect(epic.status).toEqual("scaffolding");
    expect(typeof epic.createdAt).toEqual("string");
    expect(typeof epic.updatedAt).toEqual("string");
  });

  it("shows task details", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(["show", "1-show-epic.1"], tempDir);
    const task = result.task as Record<string, unknown>;
    expect(task.id).toEqual("1-show-epic.1");
    expect(task.epic).toEqual("1-show-epic");
    expect(task.title).toEqual("Test task");
    expect(task.status).toEqual("todo");
    expect(task.assignee).toEqual(null);
    expect(task.evidence).toEqual(null);
    expect(task.blockReason).toEqual(null);
    expect(task.dependsOn).toEqual([]);
  });

  it("errors on invalid ID format", async () => {
    await expect(dispatch(["show", "not-an-id"], tempDir)).rejects.toThrow("Invalid ID format");
  });

  it("errors on nonexistent epic", async () => {
    await expect(dispatch(["show", "99-nonexistent"], tempDir)).rejects.toThrow("Epic not found");
  });

  it("errors on nonexistent task", async () => {
    await expect(dispatch(["show", "1-show-epic.99"], tempDir)).rejects.toThrow("Task not found");
  });
});

describe("cat", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
    await createTestEpic(tempDir, "Cat Epic");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns epic plan content", async () => {
    const result = await dispatch(["cat", "1-cat-epic"], tempDir);
    expect(result.content as string).toContain("# Plan: Cat Epic");
  });

  it("returns task plan markdown", async () => {
    await createTestTask(tempDir);

    const result = await dispatch(["cat", "1-cat-epic.1"], tempDir);
    const content = result.content as string;
    expect(content).toContain("## Description");
    expect(content).toContain("## Acceptance");
  });

  it("errors on nonexistent epic", async () => {
    await expect(dispatch(["cat", "99-nonexistent"], tempDir)).rejects.toThrow("Epic not found");
  });

  it("errors on invalid ID format", async () => {
    await expect(dispatch(["cat", "not-an-id"], tempDir)).rejects.toThrow("Invalid ID format");
  });
});

describe("list", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(epics.length).toEqual(2);
    expect(epics[0].id).toEqual("1-epic-one");
    expect(epics[1].id).toEqual("2-epic-two");

    const tasks1 = epics[0].tasks as Array<Record<string, unknown>>;
    expect(tasks1.length).toEqual(2);
    expect(tasks1[0].id).toEqual("1-epic-one.1");
    expect(tasks1[1].id).toEqual("1-epic-one.2");

    const tasks2 = epics[1].tasks as Array<Record<string, unknown>>;
    expect(tasks2.length).toEqual(1);
    expect(tasks2[0].id).toEqual("2-epic-two.1");
  });

  it("returns empty array when no epics exist", async () => {
    const result = await dispatch(["list"], tempDir);
    const epics = result.epics as Array<Record<string, unknown>>;
    expect(epics.length).toEqual(0);
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

    expect(task.id).toEqual("1-field-epic.1");
    expect(task.title).toEqual("Test task");
    expect(task.status).toEqual("in_progress");
    expect(task.assignee).toEqual("test-agent");
    // Should NOT include full task fields like evidence, blockReason, etc.
    expect("evidence" in task).toEqual(false);
    expect("blockReason" in task).toEqual(false);
  });
});

describe("tasks", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
    await createTestEpic(tempDir, "Tasks Epic");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(tasks.length).toEqual(3);
    expect(tasks[0].id).toEqual("1-tasks-epic.1");
    expect(tasks[1].id).toEqual("1-tasks-epic.2");
    expect(tasks[2].id).toEqual("1-tasks-epic.3");
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
    expect(tasks.length).toEqual(1);
    expect(tasks[0].id).toEqual("1-tasks-epic.2");
    expect(tasks[0].status).toEqual("in_progress");
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
    expect(tasks.length).toEqual(1);
    expect(tasks[0].id).toEqual("1-tasks-epic.1");
    expect(tasks[0].status).toEqual("code_review");
  });

  it("returns empty array when no tasks match filter", async () => {
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    const result = await dispatch(
      ["tasks", "--epic", "1-tasks-epic", "--status", "done"],
      tempDir,
    );
    const tasks = result.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toEqual(0);
  });

  it("errors on invalid status filter", async () => {
    await expect(dispatch(
          ["tasks", "--epic", "1-tasks-epic", "--status", "invalid"],
          tempDir,
        )).rejects.toThrow("Invalid status");
  });

  it("errors on nonexistent epic", async () => {
    await expect(dispatch(["tasks", "--epic", "99-nonexistent"], tempDir)).rejects.toThrow("Epic not found");
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
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[0].title).toEqual("Test task");
    expect(tasks[1].dependsOn).toEqual([1]);
    expect(tasks[1].title).toEqual("Test task");
  });
});

describe("formatLogEntry", () => {
  it("produces correct markdown structure", () => {
    const entry = formatLogEntry(
      "2026-03-03T12:00:00.000Z",
      ["epic", "create", "--title", "Test", "--file", "/tmp/plan.md"],
      { success: true, id: "1-test" },
    );
    expect(entry).toContain("### 2026-03-03T12:00:00.000Z");
    expect(entry).toContain("epic create --title Test --file /tmp/plan.md");
    expect(entry).toContain("```json");
    expect(entry).toContain('"success": true');
    expect(entry).toContain('"id": "1-test"');
  });

  it("quotes args containing spaces", () => {
    const entry = formatLogEntry(
      "2026-03-03T12:00:00.000Z",
      ["epic", "create", "--title", "A task with spaces"],
      { success: true },
    );
    expect(entry).toContain('"A task with spaces"');
  });

  it("formats error results", () => {
    const entry = formatLogEntry(
      "2026-03-03T12:00:00.000Z",
      ["start", "1-foo.99"],
      { success: false, error: "Task not found: 1-foo.99" },
    );
    expect(entry).toContain('"success": false');
    expect(entry).toContain("Task not found");
  });
});

describe("appendLogEntry", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("writes to global.md for epic-less commands", async () => {
    const store = new AgentqStore(tempDir);
    await appendLogEntry(store, ["list"], { success: true, epics: [] });
    const content = await readFile(`${tempDir}/agentq/logs/global.md`, "utf-8");
    expect(content).toContain("list");
    expect(content).toContain('"success": true');
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
    for (const entry of await readdir(`${tempDir}/agentq/logs`, { withFileTypes: true })) {
      if (entry.name.endsWith(`${epicId}.md`)) files.push(entry.name);
    }
    expect(files.length).toEqual(1);

    const content = await readFile(
      `${tempDir}/agentq/logs/${files[0]}`,
      "utf-8",
    );
    expect(content).toContain(`ready --epic ${epicId}`);
  });

  it("appends to existing log file", async () => {
    const store = new AgentqStore(tempDir);
    await appendLogEntry(store, ["list"], { success: true, epics: [] });
    await appendLogEntry(store, ["list"], {
      success: true,
      epics: [{ id: "1-x" }],
    });

    const content = await readFile(`${tempDir}/agentq/logs/global.md`, "utf-8");
    const headings = content.split("\n").filter((l: string) =>
      l.startsWith("### ")
    );
    expect(headings.length).toEqual(2);
  });

  it("falls back to global log when epic does not exist", async () => {
    const store = new AgentqStore(tempDir);
    await appendLogEntry(
      store,
      ["show", "999-nonexistent"],
      { success: false, error: "Epic not found" },
      "999-nonexistent",
    );
    const content = await readFile(`${tempDir}/agentq/logs/global.md`, "utf-8");
    expect(content).toContain("show 999-nonexistent");
  });
});

describe("dispatch error paths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("rejects unknown command", async () => {
    await expect(dispatch(["foobar"], tempDir)).rejects.toThrow("Unknown command: foobar");
  });

  it("rejects empty args", async () => {
    await expect(dispatch([], tempDir)).rejects.toThrow("Unknown command: undefined");
  });

  it("rejects unknown epic subcommand", async () => {
    await expect(dispatch(["epic", "foobar"], tempDir)).rejects.toThrow("Unknown epic subcommand: foobar");
  });

  it("rejects unknown task subcommand", async () => {
    await expect(dispatch(["task", "foobar"], tempDir)).rejects.toThrow("Unknown task subcommand: foobar");
  });
});

describe("command arg validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("task set-deps rejects missing --deps", async () => {
    // Create epic and task so the ID validation passes
    await createTestEpic(tempDir, "Deps Test");
    await createTestTask(tempDir);
    await finalizeEpic(tempDir);

    await expect(dispatch(["task", "set-deps", "1-deps-test.1"], tempDir)).rejects.toThrow("--deps is required");
  });
});

describe("output shape", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
    restoreActor = withActor("test-agent");
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
  });

  it("does not leak internal _epic field in command outputs", async () => {
    const planFile = `${tempDir}/_tmp.md`;
    await writeFile(planFile, "# Plan\n");
    const epic = await dispatch(
      ["epic", "create", "--title", "Output Shape", "--file", planFile],
      tempDir,
    );
    const epicId = epic.id as string;

    const taskFile = `${tempDir}/_tmp_task.md`;
    await writeFile(taskFile, "## Task\n");
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
      expect(Object.prototype.hasOwnProperty.call(response, "_epic")).toEqual(false);
    }
  });
});

describe("loadMeta corruption", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("rejects corrupt meta.json", async () => {
    // Write invalid JSON to meta.json
    await writeFile(
      `${tempDir}/agentq/meta.json`,
      "{not valid json!!!",
    );

    const planFile = `${tempDir}/_tmp.md`;
    await writeFile(planFile, "# Plan\n");
    await expect(dispatch(
          ["epic", "create", "--title", "Anything", "--file", planFile],
          tempDir,
        )).rejects.toThrow("meta.json not found or corrupt");
  });

  it("rejects missing meta.json", async () => {
    // Delete meta.json
    await rm(`${tempDir}/agentq/meta.json`);

    const planFile = `${tempDir}/_tmp.md`;
    await writeFile(planFile, "# Plan\n");
    await expect(dispatch(
          ["epic", "create", "--title", "Anything", "--file", planFile],
          tempDir,
        )).rejects.toThrow("meta.json not found or corrupt");
  });
});

describe("task set-deps clearing", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(taskBefore.dependsOn).toEqual([1]);

    // Clear deps with empty string
    await dispatch(["task", "set-deps", "1-clear-deps.2", "--deps", ""], tempDir);

    // Verify deps are now empty
    const after = await dispatch(["show", "1-clear-deps.2"], tempDir);
    const taskAfter = after.task as Record<string, unknown>;
    expect(taskAfter.dependsOn).toEqual([]);
  });
});

describe("block preserves assignee", () => {
  let tempDir: string;
  let restoreActor: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    restoreActor = withActor("test-agent");
    await setupState(tempDir);
  });

  afterEach(async () => {
    if (restoreActor) restoreActor();
    restoreActor = null;
    await rm(tempDir, { recursive: true });
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
    expect(task.status).toEqual("blocked");
    expect(task.assignee).toEqual("test-agent");
    expect(task.blockReason).toEqual("waiting on external API");
  });
});

describe("corrupt state handling", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("loadEpic reports corrupt JSON, not 'not found'", async () => {
    const epicDir = `${tempDir}/agentq/epics/1-broken`;
    await mkdir(epicDir, { recursive: true });
    await writeFile(`${epicDir}/state.json`, "{invalid json");

    const store = new AgentqStore(tempDir);
    await expect(store.loadEpic("1-broken")).rejects.toThrow("corrupt");
  });

  it("loadTask reports corrupt JSON, not 'not found'", async () => {
    const taskDir = `${tempDir}/agentq/tasks/1-broken`;
    await mkdir(taskDir, { recursive: true });
    await writeFile(`${taskDir}/1.state.json`, "{bad");

    const store = new AgentqStore(tempDir);
    await expect(store.loadTask("1-broken.1")).rejects.toThrow("corrupt");
  });

  it("loadEpic still reports 'not found' for missing files", async () => {
    const store = new AgentqStore(tempDir);
    await expect(store.loadEpic("99-nonexistent")).rejects.toThrow("not found");
  });
});

describe("backward compat: task without title field", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("loadTask defaults missing title to '(untitled)'", async () => {
    // Write a task state.json that lacks the title field (pre-title schema)
    const taskDir = `${tempDir}/agentq/tasks/1-old-epic`;
    await mkdir(taskDir, { recursive: true });
    await writeFile(
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
    expect(task.title).toEqual("(untitled)");
  });

  it("loadAllTasks defaults missing title to '(untitled)'", async () => {
    const taskDir = `${tempDir}/agentq/tasks/1-old-epic`;
    await mkdir(taskDir, { recursive: true });
    await writeFile(
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
    expect(tasks.length).toEqual(1);
    expect(tasks[0].title).toEqual("(untitled)");
  });

  it("loadTask defaults non-string title to '(untitled)'", async () => {
    // Corrupted file with title as array — truthy but not a string
    const taskDir = `${tempDir}/agentq/tasks/1-old-epic`;
    await mkdir(taskDir, { recursive: true });
    await writeFile(
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
    expect(task.title).toEqual("(untitled)");
  });
});

describe("task set-deps on done task", () => {
  let tempDir: string;
  let restoreActor: () => void;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
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
    await rm(tempDir, { recursive: true });
  });

  it("rejects set-deps on a completed task", async () => {
    await expect(dispatch(
          ["task", "set-deps", "1-done-guard.1", "--deps", "2"],
          tempDir,
        )).rejects.toThrow("Cannot modify deps of a completed task");
  });
});
