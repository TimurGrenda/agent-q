import type { JsonObject } from "./types.ts";

/** Lowercase, replace non-alphanumeric with hyphens, collapse runs, trim edges. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Matches epic IDs like 1-my-epic */
export function isEpicId(id: string): boolean {
  return /^\d+-[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** Matches task IDs like 1-my-epic.2 (task number starts at 1, never 0) */
export function isTaskId(id: string): boolean {
  return /^\d+-[a-z0-9]+(-[a-z0-9]+)*\.[1-9]\d*$/.test(id);
}

/** Validate and narrow a task ID argument. */
export function validateTaskId(id: string | undefined): asserts id is string {
  if (!id) throw new Error("Task ID is required");
  if (!isTaskId(id)) throw new Error(`Invalid task ID: ${id}`);
}

/** Validate and narrow an epic ID argument. */
export function validateEpicId(
  epicId: string | undefined,
): asserts epicId is string {
  if (!epicId) throw new Error("--epic is required");
  if (!isEpicId(epicId)) throw new Error(`Invalid epic ID: ${epicId}`);
}

/** Return the current actor: env var AGENTQ_ACTOR, then git config user.name. */
export async function getActor(): Promise<string> {
  const envActor = Deno.env.get("AGENTQ_ACTOR");
  if (envActor) return envActor;

  const cmd = new Deno.Command("git", {
    args: ["config", "user.name"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.success) {
    const name = new TextDecoder().decode(output.stdout).trim();
    if (name) return name;
  }
  throw new Error(
    "Cannot determine actor: set AGENTQ_ACTOR or git config user.name",
  );
}

/** Replace or append a ## heading section in markdown. */
export function updateSpecSection(
  markdown: string,
  heading: string,
  content: string,
): string {
  const lines = markdown.split("\n");
  const headingLine = `## ${heading}`;
  const startIdx = lines.findIndex((line) => line.trimEnd() === headingLine);

  if (startIdx === -1) {
    const trimmed = markdown.endsWith("\n") ? markdown : markdown + "\n";
    return trimmed + "\n" + headingLine + "\n\n" + content + "\n";
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      endIdx = i;
      break;
    }
  }

  const before = lines.slice(0, startIdx + 1);
  const after = lines.slice(endIdx);
  return [...before, "", content, "", ...after].join("\n");
}

/** Parse and validate evidence JSON string. Returns parsed object or undefined. */
export function parseEvidence(
  evidenceStr: string | undefined,
): JsonObject | undefined {
  if (!evidenceStr) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceStr);
  } catch (error) {
    throw new Error(`Invalid evidence JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Evidence must be a JSON object");
  }
  return parsed as JsonObject;
}

export function now(): string {
  return new Date().toISOString();
}

export function parseTaskNumber(taskId: string): number {
  return parseInt(taskId.split(".").pop() ?? "0", 10);
}

export function parseEpicNumber(epicId: string): number {
  return parseInt(epicId.split("-")[0] ?? "0", 10);
}

/** Extract the epic ID portion from a task ID (everything before the last dot). */
export function epicIdFromTaskId(taskId: string): string {
  return taskId.substring(0, taskId.lastIndexOf("."));
}
