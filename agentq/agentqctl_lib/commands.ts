import {
  attemptEpicAutoClose,
  findScaffoldingEpic,
  getReadyTasks,
  nextTaskNumber,
  parseDeps,
} from "./domain.ts";
import {
  type CommandExecution,
  type EpicData,
  type JsonObject,
  type ParsedCliArgs,
  TASK_STATUSES,
  type TaskData,
} from "./types.ts";
import {
  epicIdFromTaskId,
  getActor,
  isEpicId,
  isTaskId,
  now,
  parseEvidence,
  parseTaskNumber,
  slugify,
  updateSpecSection,
  validateEpicId,
  validateTaskId,
} from "./utils.ts";

export interface CommandContext {
  store: import("./store.ts").AgentqStore;
  root: string;
  parsed: ParsedCliArgs;
  positional: string[];
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandExecution>;

export interface CommandNode {
  run?: CommandHandler;
  subcommands?: Record<string, CommandHandler>;
}

async function cmdEpicCreate(ctx: CommandContext): Promise<CommandExecution> {
  const rawTitle = ctx.parsed.title;
  const filePath = ctx.parsed.file;
  if (!rawTitle) throw new Error("--title is required");
  if (rawTitle.includes("\n") || rawTitle.includes("\r")) {
    throw new Error("Title must be a single line");
  }
  const title = rawTitle.trim();
  if (!title) throw new Error("--title must not be blank");
  if (title.length > 200) {
    throw new Error("Title must be 200 characters or fewer");
  }
  if (!filePath) throw new Error("--file is required");

  const slug = slugify(title);
  if (!slug) throw new Error("Title produces empty slug");

  // Read and increment nextId from meta.json
  const meta = await ctx.store.loadMeta();
  const num = meta.nextId;
  const id = `${num}-${slug}`;

  // Check no epic with this ID already exists
  try {
    await ctx.store.loadEpic(id);
    throw new Error(`Epic already exists: ${id}`);
  } catch (e) {
    if ((e as Error).message.startsWith("Epic already exists")) throw e;
    // Expected: epic not found, proceed
  }

  // Check no other epic is in scaffolding state
  const allEpics = await ctx.store.loadAllEpics();
  const scaffolding = allEpics.filter((e) => e.status === "scaffolding");
  if (scaffolding.length > 0) {
    throw new Error(
      `Another epic is already in scaffolding state: ${scaffolding[0].id}`,
    );
  }

  // Validate source plan file exists
  const resolvedFile = filePath.startsWith("/")
    ? filePath
    : `${ctx.root}/${filePath}`;
  try {
    const stat = await Deno.stat(resolvedFile);
    if (!stat.isFile) throw new Error(`Not a file: ${filePath}`);
  } catch (e) {
    if ((e as Error).message.startsWith("Not a file")) throw e;
    throw new Error(`File not found: ${filePath}`);
  }

  // Copy plan file first — if this fails, no state is persisted
  const timestamp = now();
  const epic: EpicData = {
    id,
    status: "scaffolding",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await ctx.store.copyFile(resolvedFile, ctx.store.epicPlanPath(id));

  // Save epic state and increment nextId only after plan copy succeeded
  await ctx.store.saveEpic(epic);
  meta.nextId = num + 1;
  await ctx.store.saveMeta(meta);

  return { output: { id, status: "scaffolding" }, epicId: id };
}

async function cmdEpicFinalize(ctx: CommandContext): Promise<CommandExecution> {
  // Accept optional positional epic ID, otherwise find scaffolding epic
  const epicIdArg = ctx.positional[2];
  let epic: EpicData;

  if (epicIdArg) {
    validateEpicId(epicIdArg);
    epic = await ctx.store.loadEpic(epicIdArg);
  } else {
    epic = await findScaffoldingEpic(ctx.store);
  }

  if (epic.status !== "scaffolding") {
    throw new Error(
      `Epic ${epic.id} is not in scaffolding state (status: ${epic.status})`,
    );
  }

  // Validate epic has at least one task
  const tasks = await ctx.store.loadAllTasks(epic.id);
  if (tasks.length === 0) {
    throw new Error(
      `Epic ${epic.id} has no tasks. Add tasks before finalizing.`,
    );
  }

  epic.status = "open";
  epic.updatedAt = now();
  await ctx.store.saveEpic(epic);

  return { output: { id: epic.id, status: "open" }, epicId: epic.id };
}

async function cmdTaskCreate(ctx: CommandContext): Promise<CommandExecution> {
  const rawTitle = ctx.parsed.title;
  const filePath = ctx.parsed.file;
  const depsStr = ctx.parsed.deps;
  if (!rawTitle) throw new Error("--title is required");
  if (rawTitle.includes("\n") || rawTitle.includes("\r")) {
    throw new Error("Title must be a single line");
  }
  const title = rawTitle.trim();
  if (!title) throw new Error("--title must not be blank");
  if (title.length > 200) {
    throw new Error("Title must be 200 characters or fewer");
  }
  if (!filePath) throw new Error("--file is required");

  // Find scaffolding epic
  const epic = await findScaffoldingEpic(ctx.store);
  const epicId = epic.id;

  // Parse and validate deps (plain numbers)
  const deps = await parseDeps(ctx.store, depsStr, epicId);

  // Assign next task number
  const taskNumber = await nextTaskNumber(ctx.store, epicId);
  const id = `${epicId}.${taskNumber}`;

  // Validate source file exists
  const resolvedFile = filePath.startsWith("/")
    ? filePath
    : `${ctx.root}/${filePath}`;
  try {
    const stat = await Deno.stat(resolvedFile);
    if (!stat.isFile) throw new Error(`Not a file: ${filePath}`);
  } catch (e) {
    if ((e as Error).message.startsWith("Not a file")) throw e;
    throw new Error(`File not found: ${filePath}`);
  }

  // Create task state
  const timestamp = now();
  const task: TaskData = {
    id,
    epic: epicId,
    title,
    status: "todo",
    dependsOn: deps,
    assignee: null,
    evidence: null,
    blockReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  // Copy plan file first (before state) to prevent partial writes
  await ctx.store.copyFile(resolvedFile, ctx.store.taskPlanPath(epicId, taskNumber));
  await ctx.store.saveTask(task);

  return { output: { id, epic: epicId, taskNumber, title }, epicId };
}

async function cmdTaskSetDeps(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[2];
  const depsStr = ctx.parsed.deps;

  validateTaskId(id);
  if (depsStr === undefined) throw new Error("--deps is required");

  const task = await ctx.store.loadTask(id);
  if (task.status === "done") {
    throw new Error(`Cannot modify deps of a completed task: ${id}`);
  }
  const taskNum = parseTaskNumber(id);
  const deps = await parseDeps(ctx.store, depsStr, task.epic, taskNum);

  task.dependsOn = deps;
  task.updatedAt = now();
  await ctx.store.saveTask(task);

  return { output: { id, dependsOn: deps }, epicId: task.epic };
}

async function cmdStart(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  validateTaskId(id);

  const task = await ctx.store.loadTask(id);

  // Guard: cannot start tasks on an epic still in scaffolding state
  const epic = await ctx.store.loadEpic(task.epic);
  if (epic.status === "scaffolding") {
    throw new Error(
      `Cannot start tasks on epic ${task.epic} — it is still in scaffolding state. Run 'epic finalize' first.`,
    );
  }

  if (task.status === "done") throw new Error(`Task ${id} is already done`);
  if (task.status === "in_progress") {
    throw new Error(
      `Task ${id} is already in progress (assigned to ${task.assignee})`,
    );
  }
  if (task.status === "blocked") {
    throw new Error(`Task ${id} is blocked: ${task.blockReason}`);
  }
  if (task.status === "code_review") {
    throw new Error(`Task ${id} is in code review`);
  }

  // dependsOn contains task numbers; construct full IDs to check status
  const unmetIds: string[] = [];
  for (const depNum of task.dependsOn) {
    const depId = `${task.epic}.${depNum}`;
    const dep = await ctx.store.loadTask(depId);
    if (dep.status !== "done") unmetIds.push(depId);
  }

  if (unmetIds.length > 0) {
    throw new Error(
      `Task ${id} has unmet dependencies: ${unmetIds.join(", ")}`,
    );
  }

  const actor = await getActor();
  task.status = "in_progress";
  task.assignee = actor;
  task.updatedAt = now();
  await ctx.store.saveTask(task);

  // Transition epic from "open" to "in_progress" on first task start
  if (epic.status === "open") {
    epic.status = "in_progress";
    epic.updatedAt = now();
    await ctx.store.saveEpic(epic);
  }

  return { output: { id, title: task.title, assignee: actor }, epicId: task.epic };
}

async function cmdDone(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  const summary = ctx.parsed.summary;
  const evidenceStr = ctx.parsed.evidence;

  validateTaskId(id);

  const task = await ctx.store.loadTask(id);
  if (task.status !== "in_progress" && task.status !== "code_review") {
    throw new Error(
      `Task ${id} is not in progress or code review (status: ${task.status})`,
    );
  }

  const actor = await getActor();
  if (task.assignee !== actor) {
    throw new Error(`Task ${id} is assigned to ${task.assignee}, not ${actor}`);
  }

  const parsedEvidence = parseEvidence(evidenceStr);

  // Read the task plan file to append summary/evidence sections
  const epicId = epicIdFromTaskId(id);
  const taskNum = parseTaskNumber(id);
  const planPath = ctx.store.taskPlanPath(epicId, taskNum);
  let markdown = await Deno.readTextFile(planPath);
  if (summary) {
    markdown = updateSpecSection(markdown, "Done Summary", summary);
  }
  if (parsedEvidence) {
    markdown = updateSpecSection(
      markdown,
      "Evidence",
      "```json\n" + JSON.stringify(parsedEvidence, null, 2) + "\n```",
    );
  }
  await Deno.writeTextFile(planPath, markdown);

  task.status = "done";
  task.updatedAt = now();
  if (parsedEvidence) task.evidence = parsedEvidence;
  await ctx.store.saveTask(task);

  const epicClosed = await attemptEpicAutoClose(ctx.store, task.epic);

  return {
    output: {
      id,
      title: task.title,
      ...(epicClosed ? { epicClosed: true, epicId: task.epic } : {}),
    },
    epicId: task.epic,
  };
}

async function cmdReview(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  validateTaskId(id);

  const task = await ctx.store.loadTask(id);
  if (task.status !== "in_progress") {
    throw new Error(`Task ${id} is not in progress (status: ${task.status})`);
  }

  const actor = await getActor();
  if (task.assignee !== actor) {
    throw new Error(`Task ${id} is assigned to ${task.assignee}, not ${actor}`);
  }

  task.status = "code_review";
  task.updatedAt = now();
  await ctx.store.saveTask(task);

  return { output: { id, status: "code_review" }, epicId: task.epic };
}

async function cmdBlock(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  const reason = ctx.parsed.reason;

  validateTaskId(id);
  if (!reason) throw new Error("--reason is required");

  const task = await ctx.store.loadTask(id);
  if (task.status === "done") throw new Error(`Task ${id} is already done`);
  if (task.status === "blocked") {
    throw new Error(`Task ${id} is already blocked`);
  }

  // If task is assigned (in_progress or code_review), only the assignee can block it
  if (task.assignee !== null) {
    const actor = await getActor();
    if (task.assignee !== actor) {
      throw new Error(`Task ${id} is assigned to ${task.assignee}, not ${actor}`);
    }
  }

  task.status = "blocked";
  task.blockReason = reason;
  task.updatedAt = now();
  await ctx.store.saveTask(task);

  return { output: { id, blockReason: reason }, epicId: task.epic };
}

async function cmdUnblock(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  validateTaskId(id);

  const task = await ctx.store.loadTask(id);
  if (task.status !== "blocked") {
    throw new Error(`Task ${id} is not blocked (status: ${task.status})`);
  }

  task.status = "todo";
  task.blockReason = null;
  task.assignee = null;
  task.updatedAt = now();
  await ctx.store.saveTask(task);

  return { output: { id, status: "todo" }, epicId: task.epic };
}

async function cmdReady(ctx: CommandContext): Promise<CommandExecution> {
  const epicId = ctx.parsed.epic;
  validateEpicId(epicId);

  const epic = await ctx.store.loadEpic(epicId);
  if (epic.status === "scaffolding") {
    throw new Error(
      `Epic ${epicId} is still in scaffolding state. Run 'epic finalize' first.`,
    );
  }
  const tasks = await ctx.store.loadAllTasks(epicId);
  const readyTasks = getReadyTasks(tasks);

  return {
    output: {
      tasks: readyTasks.map((task) => ({ id: task.id, title: task.title })),
    },
    epicId,
  };
}

async function cmdNext(ctx: CommandContext): Promise<CommandExecution> {
  const epicId = ctx.parsed.epic;
  validateEpicId(epicId);

  const epic = await ctx.store.loadEpic(epicId);
  if (epic.status === "scaffolding") {
    throw new Error(
      `Epic ${epicId} is still in scaffolding state. Run 'epic finalize' first.`,
    );
  }
  const actor = await getActor();
  const tasks = await ctx.store.loadAllTasks(epicId);

  const ownActive = tasks.find((task) =>
    (task.status === "in_progress" || task.status === "code_review") &&
    task.assignee === actor
  );
  if (ownActive) {
    return {
      output: {
        status: "work",
        epic: epicId,
        task: ownActive.id,
        title: ownActive.title,
        reason: ownActive.status,
      },
      epicId,
    };
  }

  const readyTasks = getReadyTasks(tasks);
  if (readyTasks.length > 0) {
    return {
      output: {
        status: "work",
        epic: epicId,
        task: readyTasks[0].id,
        title: readyTasks[0].title,
        reason: "ready_task",
      },
      epicId,
    };
  }

  const allDone = tasks.length > 0 &&
    tasks.every((task) => task.status === "done");
  if (allDone) {
    return {
      output: {
        status: "none",
        epic: epicId,
        task: null,
        reason: "all_tasks_done",
      },
      epicId,
    };
  }

  return {
    output: {
      status: "none",
      epic: epicId,
      task: null,
      reason: "no_actionable_tasks",
    },
    epicId,
  };
}

async function cmdShow(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  if (!id) throw new Error("ID is required");

  if (isEpicId(id)) {
    const epic = await ctx.store.loadEpic(id);
    return { output: { epic }, epicId: id };
  }

  if (isTaskId(id)) {
    const task = await ctx.store.loadTask(id);
    return { output: { task }, epicId: task.epic };
  }

  throw new Error(`Invalid ID format: ${id}`);
}

async function cmdCat(ctx: CommandContext): Promise<CommandExecution> {
  const id = ctx.positional[1];
  if (!id) throw new Error("ID is required");

  let planPath: string;
  let epicId: string;

  if (isEpicId(id)) {
    await ctx.store.loadEpic(id);
    planPath = ctx.store.epicPlanPath(id);
    epicId = id;
  } else if (isTaskId(id)) {
    const task = await ctx.store.loadTask(id);
    const taskNum = parseTaskNumber(id);
    planPath = ctx.store.taskPlanPath(task.epic, taskNum);
    epicId = task.epic;
  } else {
    throw new Error(`Invalid ID format: ${id}`);
  }

  try {
    const content = await Deno.readTextFile(planPath);
    return { output: { content }, epicId };
  } catch {
    throw new Error(`Plan not found for ${id}`);
  }
}

async function cmdList(ctx: CommandContext): Promise<CommandExecution> {
  const epics = await ctx.store.loadAllEpics();
  const result: JsonObject[] = [];

  for (const epic of epics) {
    const tasks = await ctx.store.loadAllTasks(epic.id);
    result.push({
      ...epic,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
      })),
    });
  }

  return { output: { epics: result } };
}

async function cmdTasks(ctx: CommandContext): Promise<CommandExecution> {
  const epicId = ctx.parsed.epic;
  const status = ctx.parsed.status;

  validateEpicId(epicId);
  await ctx.store.loadEpic(epicId);

  if (
    status !== undefined &&
    !TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
  ) {
    throw new Error(
      `Invalid status: ${status}. Must be one of: ${TASK_STATUSES.join(", ")}`,
    );
  }

  let tasks = await ctx.store.loadAllTasks(epicId);
  if (status !== undefined) {
    tasks = tasks.filter((task) => task.status === status);
  }

  return {
    output: {
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        dependsOn: task.dependsOn,
      })),
    },
    epicId,
  };
}

export const COMMANDS: Record<string, CommandNode> = {
  epic: {
    subcommands: {
      create: cmdEpicCreate,
      finalize: cmdEpicFinalize,
    },
  },
  task: {
    subcommands: {
      create: cmdTaskCreate,
      "set-deps": cmdTaskSetDeps,
    },
  },
  start: { run: cmdStart },
  done: { run: cmdDone },
  review: { run: cmdReview },
  block: { run: cmdBlock },
  unblock: { run: cmdUnblock },
  ready: { run: cmdReady },
  next: { run: cmdNext },
  show: { run: cmdShow },
  cat: { run: cmdCat },
  list: { run: cmdList },
  tasks: { run: cmdTasks },
};
