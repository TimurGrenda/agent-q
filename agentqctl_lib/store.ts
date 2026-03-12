import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
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
      const text = await readFile(this.epicStatePath(id), "utf-8");
      return JSON.parse(text) as EpicData;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Epic state is corrupt (invalid JSON): ${id}`);
      }
      throw new Error(`Epic not found: ${id}`);
    }
  }

  async saveEpic(epic: EpicData): Promise<void> {
    await mkdir(this.epicDir(epic.id), { recursive: true });
    await writeFile(
      this.epicStatePath(epic.id),
      JSON.stringify(epic, null, 2) + "\n",
    );
  }

  async loadTask(id: string): Promise<TaskData> {
    const epicId = epicIdFromTaskId(id);
    const taskNum = parseTaskNumber(id);
    try {
      const text = await readFile(this.taskStatePath(epicId, taskNum), "utf-8");
      const data = JSON.parse(text) as TaskData;
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
    await mkdir(this.taskDir(epicId), { recursive: true });
    await writeFile(
      this.taskStatePath(epicId, taskNum),
      JSON.stringify(task, null, 2) + "\n",
    );
  }

  async loadMeta(): Promise<MetaData> {
    const metaPath = `${this.aqDir()}/meta.json`;
    try {
      const raw = await readFile(metaPath, "utf-8");
      return JSON.parse(raw) as MetaData;
    } catch {
      throw new Error(
        "meta.json not found or corrupt — run agentq-init to initialize",
      );
    }
  }

  async saveMeta(meta: MetaData): Promise<void> {
    const metaPath = `${this.aqDir()}/meta.json`;
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  }

  async loadAllTasks(epicId: string): Promise<TaskData[]> {
    const dir = this.taskDir(epicId);
    const tasks: TaskData[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".state.json")) {
          const text = await readFile(`${dir}/${entry.name}`, "utf-8");
          const data = JSON.parse(text) as TaskData;
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

  async loadAllEpics(): Promise<EpicData[]> {
    const dir = `${this.aqDir()}/epics`;
    const epics: EpicData[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const text = await readFile(
              `${dir}/${entry.name}/state.json`,
              "utf-8",
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

  async copyFile(src: string, dst: string): Promise<void> {
    const content = await readFile(src, "utf-8");
    await mkdir(dst.substring(0, dst.lastIndexOf("/")), {
      recursive: true,
    });
    await writeFile(dst, content);
  }
}
