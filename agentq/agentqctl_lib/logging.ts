import type { JsonObject } from "./types.ts";
import { now } from "./utils.ts";
import { AgentqStore } from "./store.ts";

/** Format a log entry as markdown. */
export function formatLogEntry(
  timestamp: string,
  args: string[],
  output: JsonObject,
): string {
  const command = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
    .join(" ");
  return `### ${timestamp}\n\n**Command**:\n\`\`\`\n${command}\n\`\`\`\n\n**Result**:\n\`\`\`json\n${
    JSON.stringify(output, null, 2)
  }\n\`\`\`\n`;
}

/** Append a command log entry to the appropriate log file (epic-specific or global). */
export async function appendLogEntry(
  store: AgentqStore,
  args: string[],
  output: JsonObject,
  epicId?: string | null,
): Promise<void> {
  let logPath: string;
  if (epicId) {
    try {
      const epic = await store.loadEpic(epicId);
      logPath = store.epicLogPath(epicId, epic.createdAt);
    } catch (e) {
      // Only fall back for "not found" — surface other errors (corrupt JSON, I/O)
      if (!(e instanceof Error && e.message.startsWith("Epic not found"))) {
        throw e;
      }
      logPath = store.globalLogPath();
    }
  } else {
    logPath = store.globalLogPath();
  }

  const timestamp = now();
  const entry = formatLogEntry(timestamp, args, output);

  let needsSeparator = false;
  try {
    const stat = await Deno.stat(logPath);
    needsSeparator = stat.size > 0;
  } catch {
    // file does not exist
  }

  await Deno.writeTextFile(logPath, (needsSeparator ? "\n" : "") + entry, {
    append: true,
  });
}
