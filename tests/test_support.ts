import { dispatch } from "../agentqctl.ts";

/** Creates the agentq/ directory structure and default meta.json for tests. */
export async function setupState(root: string): Promise<void> {
  const base = `${root}/agentq`;
  for (const sub of ["epics", "tasks", "logs"]) {
    await Deno.mkdir(`${base}/${sub}`, { recursive: true });
  }

  const metaPath = `${base}/meta.json`;
  try {
    await Deno.stat(metaPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(metaPath, JSON.stringify({ nextId: 1, schemaVersion: 1 }, null, 2) + "\n");
    } else {
      throw error;
    }
  }

  for (const sub of ["epics", "tasks", "logs"]) {
    await Deno.writeTextFile(`${base}/${sub}/.gitkeep`, "");
  }
}

/**
 * Creates an epic via CLI: writes plan.md to temp location, calls epic create.
 * Returns the epic ID (e.g., "1-add-user-auth").
 */
export async function createTestEpic(
  tempDir: string,
  title: string,
  planContent?: string,
): Promise<string> {
  const planFile = `${tempDir}/_tmp_plan.md`;
  await Deno.writeTextFile(
    planFile,
    planContent ?? `# Plan: ${title}\n\n**Created**: 2026-01-01T00:00:00Z\n**Status**: Ready for implementation\n`,
  );

  const result = await dispatch(
    ["epic", "create", "--title", title, "--file", planFile],
    tempDir,
  );
  return result.id as string;
}

/**
 * Creates a task via CLI: writes plan.md to temp location, calls task create.
 * The epic must be in scaffolding state.
 * Returns the full task ID (e.g., "1-add-user-auth.1").
 */
export async function createTestTask(
  tempDir: string,
  planContent?: string,
  deps?: number[],
  title?: string,
): Promise<string> {
  const taskFile = `${tempDir}/_tmp_task.md`;
  await Deno.writeTextFile(
    taskFile,
    planContent ?? `## Description\n\n(No description yet)\n\n## Acceptance\n\n- [ ] TBD\n`,
  );

  const args = ["task", "create", "--title", title ?? "Test task", "--file", taskFile];
  if (deps && deps.length > 0) {
    args.push("--deps", deps.join(","));
  }

  const result = await dispatch(args, tempDir);
  return result.id as string;
}

/** Finalizes the scaffolding epic. Returns the epic ID. */
export async function finalizeEpic(tempDir: string, epicId?: string): Promise<string> {
  const args = ["epic", "finalize"];
  if (epicId) args.push(epicId);
  const result = await dispatch(args, tempDir);
  return result.id as string;
}

/** Sets AGENTQ_ACTOR for a test and returns a restore function. */
export function withActor(actor: string): () => void {
  const previous = Deno.env.get("AGENTQ_ACTOR");
  Deno.env.set("AGENTQ_ACTOR", actor);
  return () => {
    if (previous !== undefined) {
      Deno.env.set("AGENTQ_ACTOR", previous);
    } else {
      Deno.env.delete("AGENTQ_ACTOR");
    }
  };
}
