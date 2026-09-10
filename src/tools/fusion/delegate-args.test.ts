import { describe, expect, it } from "vitest";

import {
  MAX_DELEGATE_TASKS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_TASK_FILES,
  parseDelegateArgs,
} from "./delegate-args.js";

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "t1", title: "Read the router", instructions: "Read src/http/", ...over };
}

function expectError(result: ReturnType<typeof parseDelegateArgs>): string {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

describe("parseDelegateArgs", () => {
  it("accepts a minimal single task and trims the strings", () => {
    const result = parseDelegateArgs({ tasks: [task({ id: "  t1  " })] });
    expect(result).toEqual({
      ok: true,
      tasks: [{ id: "t1", title: "Read the router", instructions: "Read src/http/" }],
    });
  });

  it("carries the optional deliverable, files and maxWorkers through", () => {
    const result = parseDelegateArgs({
      tasks: [task({ deliverable: "bullets", files: ["a.ts", "b.ts"] })],
      maxWorkers: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      maxWorkers: 3,
      tasks: [{ deliverable: "bullets", files: ["a.ts", "b.ts"] }],
    });
  });

  it("drops an empty files array rather than carrying it", () => {
    const result = parseDelegateArgs({ tasks: [task({ files: [] })] });
    expect(result.ok && result.tasks[0]).not.toHaveProperty("files");
  });

  it("rejects a missing or non-array tasks field", () => {
    expect(expectError(parseDelegateArgs({}))).toContain("tasks must be an array");
    expect(expectError(parseDelegateArgs({ tasks: "t1" }))).toContain(
      "tasks must be an array",
    );
  });

  it("rejects an empty task list", () => {
    expect(expectError(parseDelegateArgs({ tasks: [] }))).toContain(
      "at least one task",
    );
  });

  it(`rejects more than ${MAX_DELEGATE_TASKS} tasks`, () => {
    const tasks = Array.from({ length: MAX_DELEGATE_TASKS + 1 }, (_, i) =>
      task({ id: `t${i}` }),
    );
    expect(expectError(parseDelegateArgs({ tasks }))).toContain(
      `at most ${MAX_DELEGATE_TASKS}`,
    );
    // The cap is exactly at the boundary, not one below it.
    expect(parseDelegateArgs({ tasks: tasks.slice(0, MAX_DELEGATE_TASKS) }).ok).toBe(
      true,
    );
  });

  it("rejects duplicate ids — the output is keyed by them", () => {
    const error = expectError(
      parseDelegateArgs({ tasks: [task(), task({ title: "Other" })] }),
    );
    expect(error).toContain("not unique");
  });

  it("rejects blank ids, titles and instructions", () => {
    expect(expectError(parseDelegateArgs({ tasks: [task({ id: "   " })] }))).toContain(
      "id must be a non-empty string",
    );
    expect(expectError(parseDelegateArgs({ tasks: [task({ title: "" })] }))).toContain(
      "title must be a non-empty string",
    );
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ instructions: null })] })),
    ).toContain("instructions must be a non-empty string");
  });

  it(`rejects instructions longer than ${MAX_INSTRUCTIONS_CHARS} chars`, () => {
    const error = expectError(
      parseDelegateArgs({
        tasks: [task({ instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) })],
      }),
    );
    expect(error).toContain(`at most ${MAX_INSTRUCTIONS_CHARS}`);
    expect(
      parseDelegateArgs({
        tasks: [task({ instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS) })],
      }).ok,
    ).toBe(true);
  });

  it(`rejects more than ${MAX_TASK_FILES} files and non-string entries`, () => {
    expect(
      expectError(
        parseDelegateArgs({
          tasks: [task({ files: Array.from({ length: MAX_TASK_FILES + 1 }, () => "a") })],
        }),
      ),
    ).toContain(`at most ${MAX_TASK_FILES}`);
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ files: [1] })] })),
    ).toContain("non-empty strings");
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ files: "a.ts" })] })),
    ).toContain("must be an array");
  });

  it("rejects a nonsense maxWorkers but no longer an ambitious one", () => {
    // The orchestrator sizes its own fan-out, so a number wider than
    // this machine can go must run as wide as it can — not come back as
    // a validation error the model has to notice and retry.
    expect(expectError(parseDelegateArgs({ tasks: [task()], maxWorkers: 0 }))).toContain(
      "at least 1",
    );
    expect(parseDelegateArgs({ tasks: [task()], maxWorkers: 12 })).toMatchObject({
      ok: true,
      maxWorkers: 12,
    });
    expect(
      expectError(parseDelegateArgs({ tasks: [task()], maxWorkers: "2" })),
    ).toContain("must be a number");
    expect(parseDelegateArgs({ tasks: [task()], maxWorkers: 2.7 })).toMatchObject({
      ok: true,
      maxWorkers: 2,
    });
  });

  it("rejects a task that is not an object", () => {
    expect(expectError(parseDelegateArgs({ tasks: ["do the thing"] }))).toContain(
      "must be an object",
    );
    expect(expectError(parseDelegateArgs({ tasks: [[]] }))).toContain(
      "must be an object",
    );
  });

  it("never throws on hostile input", () => {
    for (const raw of [
      { tasks: [null] },
      { tasks: [{ id: {}, title: [], instructions: 7 }] },
      { tasks: [task()], maxWorkers: Number.NaN },
    ]) {
      expect(() => parseDelegateArgs(raw as Record<string, unknown>)).not.toThrow();
    }
  });
});
