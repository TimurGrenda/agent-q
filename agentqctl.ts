// agentqctl.ts — CLI entrypoint and public API for agent-q task/epic management.

import { dispatch, runCommand } from "./agentqctl_lib/dispatch.ts";
import { appendLogEntry } from "./agentqctl_lib/logging.ts";
import { AgentqStore } from "./agentqctl_lib/store.ts";

export { dispatch, runCommand };

if (import.meta.main) {
  const store = new AgentqStore(".");
  let output: Record<string, unknown>;
  let success = false;
  let epicId: string | null = null;

  try {
    const execution = await runCommand(process.argv.slice(2));
    output = { success: true, ...execution.output };
    epicId = execution.epicId ?? null;
    success = true;
  } catch (error) {
    output = { success: false, error: (error as Error).message };
  }

  console.log(JSON.stringify(output));

  try {
    await appendLogEntry(store, process.argv.slice(2), output, epicId);
  } catch {
    // Silently skip logging errors (e.g., logs dir doesn't exist)
  }

  if (!success) process.exit(1);
}
