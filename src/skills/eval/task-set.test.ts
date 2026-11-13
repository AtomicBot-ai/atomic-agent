import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_COMMAND_CHECK_TIMEOUT_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  loadTaskSet,
  parseTaskSet,
  SkillEvalTaskSetError,
} from "./task-set.js";

describe("parseTaskSet", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-eval-tasks-"));
    file = join(dir, "tasks.yaml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads every check type, defaults and the single-check shorthand", () => {
    mkdirSync(join(dir, "fixtures"));
    const set = parseTaskSet(
      [
        "skill: pdf",
        "description: Reading PDFs",
        "defaults:",
        "  maxSteps: 12",
        "  fixtures: fixtures",
        "tasks:",
        "  - id: page-count",
        "    prompt: How many pages?",
        "    check: { type: exact, expected: 3 }",
        "  - id: title",
        "    prompt: Write the title to title.txt",
        "    timeoutMs: 5000",
        "    checks:",
        "      - type: command",
        "        run: test -f title.txt",
        "      - type: regex",
        "        pattern: 'title\\.txt'",
        "        flags: i",
      ].join("\n"),
      file,
    );
    expect(set.skill).toBe("pdf");
    expect(set.description).toBe("Reading PDFs");
    expect(set.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(set.tasks).toHaveLength(2);
    const [a, b] = set.tasks;
    expect(a).toMatchObject({
      id: "page-count",
      maxSteps: 12,
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      fixturesDir: join(dir, "fixtures"),
      checks: [{ type: "exact", expected: "3", caseSensitive: false }],
    });
    expect(b!.timeoutMs).toBe(5000);
    expect(b!.checks).toEqual([
      { type: "command", run: "test -f title.txt", timeoutMs: DEFAULT_COMMAND_CHECK_TIMEOUT_MS },
      { type: "regex", pattern: "title\\.txt", flags: "i" },
    ]);
  });

  it("parses JSON too and leaves optional fields null", () => {
    const set = parseTaskSet(
      JSON.stringify({ tasks: [{ id: "t1", prompt: "say hi", check: { type: "regex", pattern: "hi" } }] }),
      file,
    );
    expect(set.skill).toBeNull();
    expect(set.tasks[0]).toMatchObject({ fixturesDir: null, maxSteps: null });
  });

  it.each([
    ["no tasks", "tasks: []", "non-empty list"],
    ["bad id", "tasks:\n  - id: 'a b'\n    prompt: x\n    check: { type: regex, pattern: x }", ".id must be"],
    ["duplicate id", "tasks:\n  - { id: a, prompt: x, check: { type: regex, pattern: x } }\n  - { id: a, prompt: y, check: { type: regex, pattern: y } }", "duplicate task id: a"],
    ["no check", "tasks:\n  - { id: a, prompt: x }", "needs `check:`"],
    ["unknown check", "tasks:\n  - { id: a, prompt: x, check: { type: judge } }", "unknown check type"],
    ["bad regex", "tasks:\n  - { id: a, prompt: x, check: { type: regex, pattern: '(' } }", "invalid regex"],
    ["empty command", "tasks:\n  - { id: a, prompt: x, check: { type: command, run: '' } }", "command needs `run`"],
    ["missing fixtures", "tasks:\n  - { id: a, prompt: x, fixtures: nope, check: { type: regex, pattern: x } }", "fixtures folder not found"],
    ["escaping fixtures", "tasks:\n  - { id: a, prompt: x, fixtures: ../.., check: { type: regex, pattern: x } }", "must stay inside"],
    ["bad maxSteps", "tasks:\n  - { id: a, prompt: x, maxSteps: 0, check: { type: regex, pattern: x } }", "positive integer"],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseTaskSet(text, file)).toThrow(SkillEvalTaskSetError);
    expect(() => parseTaskSet(text, file)).toThrow(message);
  });

  it("names the file when it cannot be read", async () => {
    await expect(loadTaskSet(join(dir, "missing.yaml"))).rejects.toThrow(/missing\.yaml: cannot read tasks file/);
  });

  it("loads from disk", async () => {
    writeFileSync(file, "tasks:\n  - { id: a, prompt: x, check: { type: exact, expected: ok } }\n");
    const set = await loadTaskSet(file);
    expect(set.sourcePath).toBe(file);
    expect(set.tasks[0]!.id).toBe("a");
  });
});
