import { parseArgs } from "@std/cli/parse-args";
import { type CommandContext, COMMANDS } from "./commands.ts";
import { AgentqStore } from "./store.ts";
import type { CommandExecution, JsonObject, ParsedCliArgs } from "./types.ts";

const STRING_FLAGS = [
  "title",
  "file",
  "epic",
  "deps",
  "summary",
  "evidence",
  "reason",
  "status",
];

function normalizeParsedArgs(raw: Record<string, unknown>): ParsedCliArgs {
  const positional = Array.isArray(raw._) ? raw._.map(String) : [];

  return {
    _: positional,
    title: typeof raw.title === "string" ? raw.title : undefined,
    file: typeof raw.file === "string" ? raw.file : undefined,
    epic: typeof raw.epic === "string" ? raw.epic : undefined,
    deps: typeof raw.deps === "string" ? raw.deps : undefined,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    evidence: typeof raw.evidence === "string" ? raw.evidence : undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
  };
}

export async function runCommand(
  args: string[],
  root = ".",
): Promise<CommandExecution> {
  const parsedRaw = parseArgs(args, { string: STRING_FLAGS }) as Record<
    string,
    unknown
  >;
  const parsed = normalizeParsedArgs(parsedRaw);
  const [command, subcommand] = parsed._;

  const node = command ? COMMANDS[command] : undefined;
  if (!node) throw new Error(`Unknown command: ${command}`);

  const ctx: CommandContext = {
    store: new AgentqStore(root),
    root,
    parsed,
    positional: parsed._,
  };

  if (node.subcommands) {
    const handler = subcommand ? node.subcommands[subcommand] : undefined;
    if (!handler) {
      throw new Error(`Unknown ${command} subcommand: ${subcommand}`);
    }
    return await handler(ctx);
  }

  if (!node.run) {
    throw new Error(`Unknown command: ${command}`);
  }

  return await node.run(ctx);
}

export async function dispatch(
  args: string[],
  root = ".",
): Promise<JsonObject> {
  const execution = await runCommand(args, root);
  return execution.output;
}
