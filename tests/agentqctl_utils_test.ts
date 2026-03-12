// agentqctl_utils_test.ts — Direct unit tests for exported utility functions.
// These functions were previously only exercised indirectly through command handler tests.

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../agentqctl.ts";
import { parseDeps } from "../agentqctl_lib/domain.ts";
import { AgentqStore } from "../agentqctl_lib/store.ts";
import {
  isEpicId,
  isTaskId,
  parseEvidence,
  slugify,
  updateSpecSection,
} from "../agentqctl_lib/utils.ts";
import { createTestEpic, createTestTask, finalizeEpic, setupState } from "./test_support.ts";

// ── slugify ──────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("basic lowercase + hyphenation", () => {
    expect(slugify("Hello World")).toEqual("hello-world");
  });

  it("consecutive special chars collapse", () => {
    expect(slugify("a!!b")).toEqual("a-b");
  });

  it("leading/trailing hyphens stripped", () => {
    expect(slugify("--hello--")).toEqual("hello");
  });

  it("empty string", () => {
    expect(slugify("")).toEqual("");
  });

  it("pure special chars", () => {
    expect(slugify("!!!")).toEqual("");
  });

  it("numbers preserved", () => {
    expect(slugify("v2-beta")).toEqual("v2-beta");
  });

  it("unicode replaced", () => {
    // é is non-alphanumeric in the [^a-z0-9] regex, becomes hyphen, trailing stripped
    expect(slugify("café")).toEqual("caf");
  });

  it("mixed case with numbers", () => {
    expect(slugify("Build Auth v2")).toEqual("build-auth-v2");
  });
});

// ── isEpicId ─────────────────────────────────────────────────────────────────

describe("isEpicId", () => {
  it("valid simple", () => {
    expect(isEpicId("1-foo")).toEqual(true);
  });

  it("valid multi-segment", () => {
    expect(isEpicId("123-multi-segment")).toEqual(true);
  });

  it("valid single char slug", () => {
    expect(isEpicId("1-a")).toEqual(true);
  });

  it("invalid: no slug", () => {
    expect(isEpicId("1-")).toEqual(false);
  });

  it("invalid: uppercase", () => {
    expect(isEpicId("1-Foo")).toEqual(false);
  });

  it("invalid: task ID", () => {
    expect(isEpicId("1-foo.1")).toEqual(false);
  });

  it("invalid: empty string", () => {
    expect(isEpicId("")).toEqual(false);
  });

  it("invalid: old aq- prefix", () => {
    expect(isEpicId("aq-1-foo")).toEqual(false);
  });

  it("zero number is allowed by regex", () => {
    // The regex allows 0 as the numeric part — this is by design
    expect(isEpicId("0-test")).toEqual(true);
  });
});

// ── isTaskId ─────────────────────────────────────────────────────────────────

describe("isTaskId", () => {
  it("valid simple", () => {
    expect(isTaskId("1-foo.1")).toEqual(true);
  });

  it("valid large numbers", () => {
    expect(isTaskId("999-bar.123")).toEqual(true);
  });

  it("invalid: epic ID", () => {
    expect(isTaskId("1-foo")).toEqual(false);
  });

  it("invalid: trailing dot", () => {
    expect(isTaskId("1-foo.")).toEqual(false);
  });

  it("invalid: empty", () => {
    expect(isTaskId("")).toEqual(false);
  });

  it("invalid: double dot", () => {
    expect(isTaskId("1-foo.1.2")).toEqual(false);
  });

  it("invalid: old aq- prefix", () => {
    expect(isTaskId("aq-1-foo.1")).toEqual(false);
  });
});

// ── updateSpecSection ────────────────────────────────────────────────────────

describe("updateSpecSection", () => {
  it("append to empty markdown", () => {
    const result = updateSpecSection("", "Summary", "Done.");
    expect(result).toEqual("\n\n## Summary\n\nDone.\n");
  });

  it("append new section to existing", () => {
    const input = "## Existing\n\nContent\n";
    const result = updateSpecSection(input, "Summary", "New stuff.");
    // Should contain original content and the new section
    expect(result.includes("## Existing")).toEqual(true);
    expect(result.includes("Content")).toEqual(true);
    expect(result.includes("## Summary")).toEqual(true);
    expect(result.includes("New stuff.")).toEqual(true);
  });

  it("replace existing section", () => {
    const input = "## Summary\n\nOld content\n\n## Next\n\nKeep this\n";
    const result = updateSpecSection(input, "Summary", "New content");
    expect(result.includes("New content")).toEqual(true);
    expect(result.includes("Old content")).toEqual(false);
    expect(result.includes("## Next")).toEqual(true);
    expect(result.includes("Keep this")).toEqual(true);
  });

  it("replace last section (no next heading)", () => {
    const input = "## Summary\n\nOld content\n";
    const result = updateSpecSection(input, "Summary", "New content");
    expect(result.includes("New content")).toEqual(true);
    expect(result.includes("Old content")).toEqual(false);
  });

  it("section between two sections", () => {
    const input = "## A\n\nAlpha\n\n## B\n\nBravo\n\n## C\n\nCharlie\n";
    const result = updateSpecSection(input, "B", "Updated");
    expect(result.includes("## A")).toEqual(true);
    expect(result.includes("Alpha")).toEqual(true);
    expect(result.includes("Updated")).toEqual(true);
    expect(result.includes("Bravo")).toEqual(false); // original "Bravo" replaced
    expect(result.includes("## C")).toEqual(true);
    expect(result.includes("Charlie")).toEqual(true);
  });

  it("empty content replacement", () => {
    const input = "## Summary\n\nOld content\n\n## Next\n\nKeep\n";
    const result = updateSpecSection(input, "Summary", "");
    expect(result.includes("## Summary")).toEqual(true);
    expect(result.includes("Old content")).toEqual(false);
    expect(result.includes("## Next")).toEqual(true);
    expect(result.includes("Keep")).toEqual(true);
  });
});

// ── parseEvidence ────────────────────────────────────────────────────────────

describe("parseEvidence", () => {
  it("valid JSON object", () => {
    expect(parseEvidence('{"key":"val"}')).toEqual({ key: "val" });
  });

  it("undefined input", () => {
    expect(parseEvidence(undefined)).toEqual(undefined);
  });

  it("empty string", () => {
    expect(parseEvidence("")).toEqual(undefined);
  });

  it("invalid JSON", () => {
    expect(() => parseEvidence("not json")).toThrow(
      "Invalid evidence JSON",
    );
  });

  it("JSON array", () => {
    expect(() => parseEvidence("[1,2,3]")).toThrow(
      "Evidence must be a JSON object",
    );
  });

  it("JSON null", () => {
    expect(() => parseEvidence("null")).toThrow(
      "Evidence must be a JSON object",
    );
  });

  it("JSON string primitive", () => {
    expect(() => parseEvidence('"hello"')).toThrow(
      "Evidence must be a JSON object",
    );
  });

  it("JSON number", () => {
    expect(() => parseEvidence("42")).toThrow(
      "Evidence must be a JSON object",
    );
  });

  it("JSON boolean", () => {
    expect(() => parseEvidence("true")).toThrow(
      "Evidence must be a JSON object",
    );
  });
});

// ── parseDeps ────────────────────────────────────────────────────────────────

describe("parseDeps", () => {
  let tempDir: string;
  let store: AgentqStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentq-"));
    store = new AgentqStore(tempDir);
    await setupState(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  /** Helper: create an epic and N tasks, returning the epic ID. */
  async function createEpicWithTasks(count: number): Promise<string> {
    const epicId = await createTestEpic(tempDir, "test");
    for (let i = 0; i < count; i++) {
      await createTestTask(tempDir);
    }
    await finalizeEpic(tempDir);
    return epicId;
  }

  it("empty deps string", async () => {
    const result = await parseDeps(store, "", "1-test");
    expect(result).toEqual([]);
  });

  it("undefined deps", async () => {
    const result = await parseDeps(store, undefined, "1-test");
    expect(result).toEqual([]);
  });

  it("self-dependency", async () => {
    await createEpicWithTasks(1);
    expect(
      parseDeps(store, "1", "1-test", 1),
    ).rejects.toThrow("cannot depend on itself");
  });

  it("2-node cycle A->B->A", async () => {
    // Create epic with 2 tasks
    await createEpicWithTasks(2);
    // Set .2 to depend on .1
    await dispatch(
      ["task", "set-deps", "1-test.2", "--deps", "1"],
      tempDir,
    );
    // Now try to make .1 depend on .2 — should detect cycle: .1 -> .2 -> .1
    expect(
      parseDeps(store, "2", "1-test", 1),
    ).rejects.toThrow("Circular dependency detected");
  });

  it("3-node cycle A->B->C->A", async () => {
    // Create 3 tasks
    await createEpicWithTasks(3);
    // .2 depends on .1, .3 depends on .2
    await dispatch(
      ["task", "set-deps", "1-test.2", "--deps", "1"],
      tempDir,
    );
    await dispatch(
      ["task", "set-deps", "1-test.3", "--deps", "2"],
      tempDir,
    );
    // Now try to make .1 depend on .3 — cycle: .1 -> .3 -> .2 -> .1
    expect(
      parseDeps(store, "3", "1-test", 1),
    ).rejects.toThrow("Circular dependency detected");
  });

  it("4-node cycle", async () => {
    // .2->.1, .3->.2, .4->.3
    await createEpicWithTasks(4);
    await dispatch(
      ["task", "set-deps", "1-test.2", "--deps", "1"],
      tempDir,
    );
    await dispatch(
      ["task", "set-deps", "1-test.3", "--deps", "2"],
      tempDir,
    );
    await dispatch(
      ["task", "set-deps", "1-test.4", "--deps", "3"],
      tempDir,
    );
    // Try to make .1 depend on .4 — cycle: .1 -> .4 -> .3 -> .2 -> .1
    expect(
      parseDeps(store, "4", "1-test", 1),
    ).rejects.toThrow("Circular dependency detected");
  });

  it("diamond (not a cycle)", async () => {
    // .2->.1, .3->.1 — diamond shape, no cycle
    await createEpicWithTasks(3);
    await dispatch(
      ["task", "set-deps", "1-test.2", "--deps", "1"],
      tempDir,
    );
    // Adding .3 depends on .1 should succeed — .2 also depends on .1 but that's fine
    const result = await parseDeps(store, "1", "1-test", 3);
    expect(result).toEqual([1]);
  });
});
