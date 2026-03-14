import { type EpicData, type MetaData, type TaskData } from "./types.ts";
import { epicIdFromTaskId, parseEpicNumber, parseTaskNumber } from "./utils.ts";

export class AgentqStore {
  constructor(private readonly root: string) {}

  aqDir(): string {
    return `${this.root}/agentq`;
  }

  epicDir(id: string): string {
    return `${this.aqDir()}/epics/${id}`;
  }

  epicStatePath(id: string): string {
    return `${this.epicDir(id)}/state.json`;
  }

  epicPlanPath(id: string): string {
    return `${this.epicDir(id)}/plan.md`;
  }

  taskDir(epicId: string): string {
    return `${this.aqDir()}/tasks/${epicId}`;
  }

  taskStatePath(epicId: string, taskNum: number): string {
    return `${this.taskDir(epicId)}/${taskNum}.state.json`;
  }

  taskPlanPath(epicId: string, taskNum: number): string {
    return `${this.taskDir(epicId)}/${taskNum}.plan.md`;
  }

  logDir(): string {
    return `${this.aqDir()}/logs`;
  }

  epicLogPath(epicId: string, createdAt: string): string {
    const safeCreatedAt = createdAt.replace(/[/\\]/g, "_");
    return `${this.logDir()}/${safeCreatedAt}-${epicId}.md`;
  }

  globalLogPath(): string {
    return `${this.logDir()}/global.md`;
  }

  async loadEpic(id: string): Promise<EpicData> {
    try {
      const text = await Deno.readTextFile(this.epicStatePath(id));
      return JSON.parse(text) as EpicData;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Epic state is corrupt (invalid JSON): ${id}`);
      }
      throw new Error(`Epic not found: ${id}`);
    }
  }

  async saveEpic(epic: EpicData): Promise<void> {
    await Deno.mkdir(this.epicDir(epic.id), { recursive: true });
    await Deno.writeTextFile(
      this.epicStatePath(epic.id),
      JSON.stringify(epic, null, 2) + "\n",
    );
  }

  async loadTask(id: string): Promise<TaskData> {
    const epicId = epicIdFromTaskId(id);
    const taskNum = parseTaskNumber(id);
    try {
      const text = await Deno.readTextFile(this.taskStatePath(epicId, taskNum));
      const data = JSON.parse(text) as TaskData;
      // Backward compat: old task files created before title was required
      if (typeof data.title !== "string" || !data.title) {
        data.title = "(untitled)";
      }
      return data;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Task state is corrupt (invalid JSON): ${id}`);
      }
      throw new Error(`Task not found: ${id}`);
    }
  }

  async saveTask(task: TaskData): Promise<void> {
    const epicId = epicIdFromTaskId(task.id);
    const taskNum = parseTaskNumber(task.id);
    await Deno.mkdir(this.taskDir(epicId), { recursive: true });
    await Deno.writeTextFile(
      this.taskStatePath(epicId, taskNum),
      JSON.stringify(task, null, 2) + "\n",
    );
  }

  async loadMeta(): Promise<MetaData> {
    const metaPath = `${this.aqDir()}/meta.json`;
    try {
      const raw = await Deno.readTextFile(metaPath);
      return JSON.parse(raw) as MetaData;
    } catch {
      throw new Error(
        "meta.json not found or corrupt — run agentq-init to initialize",
      );
    }
  }

  async saveMeta(meta: MetaData): Promise<void> {
    const metaPath = `${this.aqDir()}/meta.json`;
    await Deno.writeTextFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  }

  /** Scan agentq/tasks/{epicId}/ for *.state.json files. Sort by task number. */
  async loadAllTasks(epicId: string): Promise<TaskData[]> {
    const dir = this.taskDir(epicId);
    const tasks: TaskData[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".state.json")) {
          const text = await Deno.readTextFile(`${dir}/${entry.name}`);
          const data = JSON.parse(text) as TaskData;
          // Backward compat: old task files created before title was required
          if (typeof data.title !== "string" || !data.title) {
            data.title = "(untitled)";
          }
          tasks.push(data);
        }
      }
    } catch {
      return [];
    }

    tasks.sort((a, b) => parseTaskNumber(a.id) - parseTaskNumber(b.id));
    return tasks;
  }

  /** Scan agentq/epics/ for directories. For each, read state.json. Sort by epic number. */
  async loadAllEpics(): Promise<EpicData[]> {
    const dir = `${this.aqDir()}/epics`;
    const epics: EpicData[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) {
          try {
            const text = await Deno.readTextFile(
              `${dir}/${entry.name}/state.json`,
            );
            epics.push(JSON.parse(text) as EpicData);
          } catch {
            // Skip directories without a valid state.json
          }
        }
      }
    } catch {
      return [];
    }

    epics.sort((a, b) => parseEpicNumber(a.id) - parseEpicNumber(b.id));
    return epics;
  }

  /** Copy a file from src to dst, creating parent directories as needed. */
  async copyFile(src: string, dst: string): Promise<void> {
    const content = await Deno.readTextFile(src);
    await Deno.mkdir(dst.substring(0, dst.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(dst, content);
  }
}
