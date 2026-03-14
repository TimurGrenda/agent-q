import type { EpicData, TaskData } from "./types.ts";
import { now, parseTaskNumber } from "./utils.ts";
import { AgentqStore } from "./store.ts";

/** Parse comma-separated dep numbers and validate each dep exists in the same epic. */
export async function parseDeps(
  store: AgentqStore,
  depsStr: string | undefined,
  epicId: string,
  selfTaskNum?: number,
): Promise<number[]> {
  const raw = depsStr
    ? depsStr.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  const deps: number[] = [];
  for (const token of raw) {
    const num = parseInt(token, 10);
    if (isNaN(num) || num <= 0 || String(num) !== token) {
      throw new Error(`Invalid dep number: ${token}`);
    }
    if (selfTaskNum !== undefined && num === selfTaskNum) {
      throw new Error(`Task cannot depend on itself: ${num}`);
    }
    // Validate the dep task exists in this epic
    await store.loadTask(`${epicId}.${num}`);
    deps.push(num);
  }

  if (selfTaskNum !== undefined && deps.length > 0) {
    const visited = new Set<number>();
    const stack = [...deps];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === selfTaskNum) {
        throw new Error(
          `Circular dependency detected: ${selfTaskNum} → ... → ${current}`,
        );
      }
      if (visited.has(current)) continue;

      visited.add(current);
      const task = await store.loadTask(`${epicId}.${current}`);
      for (const transitiveDep of task.dependsOn) {
        stack.push(transitiveDep);
      }
    }
  }

  return deps;
}

/** Filter tasks where status=todo and all deps are done, sorted by task number ascending. */
export function getReadyTasks(tasks: TaskData[]): TaskData[] {
  const statusMap = new Map<number, string>();
  for (const task of tasks) {
    statusMap.set(parseTaskNumber(task.id), task.status);
  }

  return tasks
    .filter((task) =>
      task.status === "todo" &&
      task.dependsOn.every((depNum) => statusMap.get(depNum) === "done")
    )
    .sort((a, b) => parseTaskNumber(a.id) - parseTaskNumber(b.id));
}

/** Scan task state files in an epic dir. Return max task number + 1. */
export async function nextTaskNumber(
  store: AgentqStore,
  epicId: string,
): Promise<number> {
  const dir = store.taskDir(epicId);
  let max = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".state.json")) {
        const match = entry.name.match(/^(\d+)\.state\.json$/);
        if (match) {
          const value = parseInt(match[1], 10);
          if (value > max) max = value;
        }
      }
    }
  } catch {
    // directory missing => max stays 0
  }
  return max + 1;
}

/** Find the single epic in "scaffolding" state. */
export async function findScaffoldingEpic(
  store: AgentqStore,
): Promise<EpicData> {
  const epics = await store.loadAllEpics();
  const scaffolding = epics.filter((e) => e.status === "scaffolding");
  if (scaffolding.length === 0) {
    throw new Error(
      "No epic in scaffolding state. Create one with `epic create`.",
    );
  }
  if (scaffolding.length > 1) {
    throw new Error(
      `Multiple epics in scaffolding state: ${scaffolding.map((e) => e.id).join(", ")}. Only one allowed.`,
    );
  }
  return scaffolding[0];
}

/**
 * Auto-close an epic if all its tasks are done.
 * Best-effort: failures are silently ignored because the task is already saved.
 */
export async function attemptEpicAutoClose(
  store: AgentqStore,
  epicId: string,
): Promise<boolean> {
  try {
    const allTasks = await store.loadAllTasks(epicId);
    const allDone = allTasks.length > 0 &&
      allTasks.every((task) => task.status === "done");
    if (allDone) {
      const epic = await store.loadEpic(epicId);
      if (epic.status === "open" || epic.status === "in_progress") {
        epic.status = "done";
        epic.updatedAt = now();
        await store.saveEpic(epic);
        return true;
      }
    }
  } catch {
    // Auto-close is best-effort — task was already saved as done successfully
  }

  return false;
}
