// agentqctl_utils_test.ts — Direct unit tests for exported utility functions.
// These functions were previously only exercised indirectly through command handler tests.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
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
    assertEquals(slugify("Hello World"), "hello-world");
  });

  it("consecutive special chars collapse", () => {
    assertEquals(slugify("a!!b"), "a-b");
  });

  it("leading/trailing hyphens stripped", () => {
    assertEquals(slugify("--hello--"), "hello");
  });

  it("empty string", () => {
    assertEquals(slugify(""), "");
  });

  it("pure special chars", () => {
    assertEquals(slugify("!!!"), "");
  });

  it("numbers preserved", () => {
    assertEquals(slugify("v2-beta"), "v2-beta");
  });

  it("unicode replaced", () => {
    // é is non-alphanumeric in the [^a-z0-9] regex, becomes hyphen, trailing stripped
    assertEquals(slugify("café"), "caf");
  });

  it("mixed case with numbers", () => {
    assertEquals(slugify("Build Auth v2"), "build-auth-v2");
  });
});

// ── isEpicId ─────────────────────────────────────────────────────────────────

describe("isEpicId", () => {
  it("valid simple", () => {
    assertEquals(isEpicId("1-foo"), true);
  });

  it("valid multi-segment", () => {
    assertEquals(isEpicId("123-multi-segment"), true);
  });

  it("valid single char slug", () => {
    assertEquals(isEpicId("1-a"), true);
  });

  it("invalid: no slug", () => {
    assertEquals(isEpicId("1-"), false);
  });

  it("invalid: uppercase", () => {
    assertEquals(isEpicId("1-Foo"), false);
  });

  it("invalid: task ID", () => {
    assertEquals(isEpicId("1-foo.1"), false);
  });

  it("invalid: empty string", () => {
    assertEquals(isEpicId(""), false);
  });

  it("invalid: old aq- prefix", () => {
    assertEquals(isEpicId("aq-1-foo"), false);
  });

  it("zero number is allowed by regex", () => {
    // The regex allows 0 as the numeric part — this is by design
    assertEquals(isEpicId("0-test"), true);
  });
});

// ── isTaskId ─────────────────────────────────────────────────────────────────

describe("isTaskId", () => {
  it("valid simple", () => {
    assertEquals(isTaskId("1-foo.1"), true);
  });

  it("valid large numbers", () => {
    assertEquals(isTaskId("999-bar.123"), true);
  });

  it("invalid: epic ID", () => {
    assertEquals(isTaskId("1-foo"), false);
  });

  it("invalid: trailing dot", () => {
    assertEquals(isTaskId("1-foo."), false);
  });

  it("invalid: empty", () => {
    assertEquals(isTaskId(""), false);
  });

  it("invalid: double dot", () => {
    assertEquals(isTaskId("1-foo.1.2"), false);
  });

  it("invalid: old aq- prefix", () => {
    assertEquals(isTaskId("aq-1-foo.1"), false);
  });
});

// ── updateSpecSection ────────────────────────────────────────────────────────

describe("updateSpecSection", () => {
  it("append to empty markdown", () => {
    const result = updateSpecSection("", "Summary", "Done.");
    assertEquals(result, "\n\n## Summary\n\nDone.\n");
  });

  it("append new section to existing", () => {
    const input = "## Existing\n\nContent\n";
    const result = updateSpecSection(input, "Summary", "New stuff.");
    // Should contain original content and the new section
    assertEquals(result.includes("## Existing"), true);
    assertEquals(result.includes("Content"), true);
    assertEquals(result.includes("## Summary"), true);
    assertEquals(result.includes("New stuff."), true);
  });

  it("replace existing section", () => {
    const input = "## Summary\n\nOld content\n\n## Next\n\nKeep this\n";
    const result = updateSpecSection(input, "Summary", "New content");
    assertEquals(result.includes("New content"), true);
    assertEquals(result.includes("Old content"), false);
    assertEquals(result.includes("## Next"), true);
    assertEquals(result.includes("Keep this"), true);
  });

  it("replace last section (no next heading)", () => {
    const input = "## Summary\n\nOld content\n";
    const result = updateSpecSection(input, "Summary", "New content");
    assertEquals(result.includes("New content"), true);
    assertEquals(result.includes("Old content"), false);
  });

  it("section between two sections", () => {
    const input = "## A\n\nAlpha\n\n## B\n\nBravo\n\n## C\n\nCharlie\n";
    const result = updateSpecSection(input, "B", "Updated");
    assertEquals(result.includes("## A"), true);
    assertEquals(result.includes("Alpha"), true);
    assertEquals(result.includes("Updated"), true);
    assertEquals(result.includes("Bravo"), false); // original "Bravo" replaced
    assertEquals(result.includes("## C"), true);
    assertEquals(result.includes("Charlie"), true);
  });

  it("empty content replacement", () => {
    const input = "## Summary\n\nOld content\n\n## Next\n\nKeep\n";
    const result = updateSpecSection(input, "Summary", "");
    assertEquals(result.includes("## Summary"), true);
    assertEquals(result.includes("Old content"), false);
    assertEquals(result.includes("## Next"), true);
    assertEquals(result.includes("Keep"), true);
  });
});

// ── parseEvidence ────────────────────────────────────────────────────────────

describe("parseEvidence", () => {
  it("valid JSON object", () => {
    assertEquals(parseEvidence('{"key":"val"}'), { key: "val" });
  });

  it("undefined input", () => {
    assertEquals(parseEvidence(undefined), undefined);
  });

  it("empty string", () => {
    assertEquals(parseEvidence(""), undefined);
  });

  it("invalid JSON", () => {
    assertThrows(
      () => parseEvidence("not json"),
      Error,
      "Invalid evidence JSON",
    );
  });

  it("JSON array", () => {
    assertThrows(
      () => parseEvidence("[1,2,3]"),
      Error,
      "Evidence must be a JSON object",
    );
  });

  it("JSON null", () => {
    assertThrows(
      () => parseEvidence("null"),
      Error,
      "Evidence must be a JSON object",
    );
  });

  it("JSON string primitive", () => {
    assertThrows(
      () => parseEvidence('"hello"'),
      Error,
      "Evidence must be a JSON object",
    );
  });

  it("JSON number", () => {
    assertThrows(
      () => parseEvidence("42"),
      Error,
      "Evidence must be a JSON object",
    );
  });

  it("JSON boolean", () => {
    assertThrows(
      () => parseEvidence("true"),
      Error,
      "Evidence must be a JSON object",
    );
  });
});

// ── parseDeps ────────────────────────────────────────────────────────────────

describe("parseDeps", () => {
  let tempDir: string;
  let store: AgentqStore;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    store = new AgentqStore(tempDir);
    await setupState(tempDir);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
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
    assertEquals(result, []);
  });

  it("undefined deps", async () => {
    const result = await parseDeps(store, undefined, "1-test");
    assertEquals(result, []);
  });

  it("self-dependency", async () => {
    await createEpicWithTasks(1);
    await assertRejects(
      () => parseDeps(store, "1", "1-test", 1),
      Error,
      "cannot depend on itself",
    );
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
    await assertRejects(
      () => parseDeps(store, "2", "1-test", 1),
      Error,
      "Circular dependency detected",
    );
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
    await assertRejects(
      () => parseDeps(store, "3", "1-test", 1),
      Error,
      "Circular dependency detected",
    );
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
    await assertRejects(
      () => parseDeps(store, "4", "1-test", 1),
      Error,
      "Circular dependency detected",
    );
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
    assertEquals(result, [1]);
  });
});
