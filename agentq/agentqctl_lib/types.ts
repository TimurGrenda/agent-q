export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "code_review",
  "blocked",
  "done",
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const EPIC_STATUSES = ["scaffolding", "open", "in_progress", "done"] as const;
export type EpicStatus = typeof EPIC_STATUSES[number];

export interface EpicData {
  id: string;
  status: EpicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskData {
  id: string;
  /** Denormalized for convenience — same as epicIdFromTaskId(id). */
  epic: string;
  title: string;
  status: TaskStatus;
  dependsOn: number[];
  assignee: string | null;
  evidence: Record<string, unknown> | null;
  blockReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetaData {
  nextId: number;
  initVersion?: string;
}

export type JsonObject = Record<string, unknown>;

export interface CommandExecution {
  output: JsonObject;
  epicId?: string;
}

export interface ParsedCliArgs {
  _: string[];
  title?: string;
  file?: string;
  epic?: string;
  deps?: string;
  summary?: string;
  evidence?: string;
  reason?: string;
  status?: string;
}
