// agentq-init.ts — Bootstrapper that sets up a project to use agent-q.
// Installs the local agentqctl CLI, creates agentq/ state, and copies skills.

/**
 * Core bootstrapper logic. Sets up a project directory for agent-q use.
 * @param sourceDir - Directory containing agentqctl.ts and skills/ (typically the agent-q repo root)
 * @param targetDir - Project root to bootstrap (defaults to "." for CWD usage)
 */
export async function runInit(
  sourceDir: string,
  targetDir = ".",
): Promise<Record<string, unknown>> {
  async function copyDirectoryRecursive(
    source: string,
    destination: string,
  ): Promise<void> {
    await Deno.mkdir(destination, { recursive: true });

    for await (const entry of Deno.readDir(source)) {
      const sourcePath = `${source}/${entry.name}`;
      const destinationPath = `${destination}/${entry.name}`;

      if (entry.isDirectory) {
        await copyDirectoryRecursive(sourcePath, destinationPath);
        continue;
      }

      if (entry.isSymlink) {
        throw new Error(
          `Symlinks are not supported in runtime modules: ${sourcePath}`,
        );
      }

      if (entry.isFile) {
        const content = await Deno.readFile(sourcePath);
        await Deno.writeFile(destinationPath, content);
      }
    }
  }

  // ── 1. Locate source files and read version ────────────────────────────

  const sourceAgentqctl = `${sourceDir}/agentqctl.ts`;
  const sourceAgentqctlModules = `${sourceDir}/agentqctl_lib`;
  const sourceSkillsDir = `${sourceDir}/skills`;

  // Read version from source deno.json (single source of truth)
  const sourceDenoJson = JSON.parse(
    await Deno.readTextFile(`${sourceDir}/deno.json`),
  );
  const version: string | undefined = sourceDenoJson.version;

  // Read schema-version from source (single integer, source of truth for storage format).
  // Uses Number() instead of parseInt() to reject trailing garbage like "1beta" or "1.5".
  // Wraps the read in try/catch so a missing file produces a friendly error, not a stack trace.
  let sourceSchemaVersion: number;
  try {
    const trimmed = (await Deno.readTextFile(`${sourceDir}/schema-version`)).trim();
    sourceSchemaVersion = Number(trimmed);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error("schema-version file is missing or not a valid integer");
    }
    throw e;
  }
  if (!Number.isInteger(sourceSchemaVersion)) {
    throw new Error("schema-version file is missing or not a valid integer");
  }

  // ── 2. Create state directories (idempotent) ───────────────────────────

  const base = `${targetDir}/agentq`;

  // Create subdirectories (idempotent via recursive: true)
  // Plans now live inside epic/task directories, no separate plans/ dir needed
  for (const sub of ["epics", "tasks", "logs"]) {
    await Deno.mkdir(`${base}/${sub}`, { recursive: true });
  }

  // Write or update meta.json.
  // On first init: create with nextId=1. On re-init: preserve existing fields.
  // Always stamps initVersion so consuming projects know which version was installed.
  // Known limitation: nextId uses read-modify-write without file locking.
  // Concurrent agentq-init or next-id calls could allocate duplicate IDs.
  // Acceptable for single-agent CLI usage.
  let stateStatus: "created" | "exists" = "exists";
  const metaPath = `${base}/meta.json`;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await Deno.readTextFile(metaPath));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      meta = { nextId: 1 };
      stateStatus = "created";
    } else {
      throw e;
    }
  }
  // Schema-version guard: refuse to overwrite scripts if state format has changed.
  // Legacy installs (no schemaVersion in meta.json) are treated as version 1.
  // Coerces through Number() so a string "1" in hand-edited meta.json doesn't false-reject.
  if (stateStatus === "exists") {
    const raw = (meta as Record<string, unknown>).schemaVersion;
    const installedSchema = raw == null ? 1 : Number(raw);
    if (installedSchema !== sourceSchemaVersion) {
      throw new Error(
        `Schema version mismatch: installed state is v${installedSchema}, ` +
        `source is v${sourceSchemaVersion}. ` +
        `Back up agentq/, remove it, and re-run agentq-init.`,
      );
    }
  }
  meta.schemaVersion = sourceSchemaVersion;
  if (version) {
    meta.initVersion = version;
  }
  await Deno.writeTextFile(
    metaPath,
    JSON.stringify(meta, null, 2) + "\n",
  );

  // Write .gitkeep files (idempotent — overwrite is fine, they're empty)
  for (const sub of ["epics", "tasks", "logs"]) {
    await Deno.writeTextFile(`${base}/${sub}/.gitkeep`, "");
  }

  // ── 3. Copy/generate tool files (always overwrite) ────────────────────

  // Copy agentqctl.ts → agentq/agentqctl.ts
  // Note: if agentq-init is installed globally but separated from its source tree,
  // this readTextFile will throw. That scenario is handled by the top-level catch.
  const agentqctlSource = await Deno.readTextFile(sourceAgentqctl);
  await Deno.writeTextFile(`${base}/agentqctl.ts`, agentqctlSource);

  // Copy modular agentqctl runtime sources (required by agentqctl.ts imports)
  try {
    await Deno.stat(sourceAgentqctlModules);
  } catch {
    throw new Error(
      `Runtime modules directory not found: ${sourceAgentqctlModules}`,
    );
  }
  await copyDirectoryRecursive(sourceAgentqctlModules, `${base}/agentqctl_lib`);

  // Generate agentq/deno.json with runtime-only import map (no test deps)
  const localDenoJson = {
    imports: {
      "@std/cli": "jsr:@std/cli@^1",
    },
  };
  await Deno.writeTextFile(
    `${base}/deno.json`,
    JSON.stringify(localDenoJson, null, 2) + "\n",
  );

  // Generate agentq/agentqctl shell wrapper
  const wrapperContent = `#!/bin/sh
# Generated by agentq-init — do not edit
exec deno run --allow-read --allow-write --allow-env=AGENTQ_ACTOR --allow-run=git --config "$(dirname "$0")/deno.json" "$(dirname "$0")/agentqctl.ts" "$@"
`;
  await Deno.writeTextFile(`${base}/agentqctl`, wrapperContent);
  // Make wrapper executable (mode 0o755)
  await Deno.chmod(`${base}/agentqctl`, 0o755);

  // ── 4. Copy skills (always overwrite) ─────────────────────────────────

  const skills: Record<string, string> = {};

  // Check if skills/ directory exists — skip silently if not (e.g., stripped distribution)
  let skillsDirExists = true;
  try {
    await Deno.stat(sourceSkillsDir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      skillsDirExists = false;
    } else {
      throw e;
    }
  }

  if (skillsDirExists) {
    // Scan source skills/ for directories starting with aq-
    // Per-file errors (e.g., missing SKILL.md) propagate intentionally
    for await (const entry of Deno.readDir(sourceSkillsDir)) {
      if (!entry.isDirectory || !entry.name.startsWith("aq-")) continue;

      const srcFile = `${sourceSkillsDir}/${entry.name}/SKILL.md`;
      const dstDir = `${targetDir}/.claude/skills/${entry.name}`;
      const dstFile = `${dstDir}/SKILL.md`;

      // Read source SKILL.md (throws if missing — a skill dir without SKILL.md is a bug)
      const content = await Deno.readTextFile(srcFile);

      // Create target directory and write file (always overwrite)
      await Deno.mkdir(dstDir, { recursive: true });
      await Deno.writeTextFile(dstFile, content);
      skills[entry.name] = "installed";
    }
  }

  // ── 5. Output ─────────────────────────────────────────────────────────

  return {
    state: stateStatus,
    script: "installed",
    wrapper: "installed",
    skills,
    ...(version ? { initVersion: version } : {}),
  };
}

// ── 6. Main entry point ───────────────────────────────────────────────────

if (import.meta.main) {
  const sourceDir = import.meta.dirname;
  if (!sourceDir) {
    console.log(
      JSON.stringify({
        success: false,
        error: "Cannot determine script directory",
      }),
    );
    Deno.exit(1);
  }
  try {
    const result = await runInit(sourceDir);
    console.log(JSON.stringify({ success: true, ...result }));
  } catch (error) {
    console.log(
      JSON.stringify({ success: false, error: (error as Error).message }),
    );
    Deno.exit(1);
  }
}
