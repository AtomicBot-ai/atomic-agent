import { describe, expect, it } from "vitest";

import {
  MAX_CONTRACT_CHECKS,
  MAX_CONTRACT_PROVIDES,
  MAX_CONTRACT_RENDERED_CHARS,
} from "./contract.js";
import {
  MAX_DELEGATE_TASKS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_TASK_FILES,
  parseDelegateArgs,
} from "./delegate-args.js";

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    title: "Read the router",
    instructions: "Read src/http/",
    ...over,
  };
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
      tasks: [
        { id: "t1", title: "Read the router", instructions: "Read src/http/" },
      ],
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
    expect(expectError(parseDelegateArgs({}))).toContain(
      "tasks must be an array",
    );
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
    expect(
      parseDelegateArgs({ tasks: tasks.slice(0, MAX_DELEGATE_TASKS) }).ok,
    ).toBe(true);
  });

  it("rejects duplicate ids — the output is keyed by them", () => {
    const error = expectError(
      parseDelegateArgs({ tasks: [task(), task({ title: "Other" })] }),
    );
    expect(error).toContain("not unique");
  });

  it("rejects blank ids, titles and instructions", () => {
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ id: "   " })] })),
    ).toContain("id must be a non-empty string");
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ title: "" })] })),
    ).toContain("title must be a non-empty string");
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
    expect(error).toContain(
      `the limit is ${MAX_INSTRUCTIONS_CHARS.toLocaleString("en-US")}`,
    );
    expect(
      parseDelegateArgs({
        tasks: [task({ instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS) })],
      }).ok,
    ).toBe(true);
  });

  it("names the limit AND the exact overage, so one retry can fix it", () => {
    // An orchestrator told only "at most N" cannot count its own output:
    // in the run that motivated this it resent a brief just as long.
    const length = MAX_INSTRUCTIONS_CHARS + 436;
    const error = expectError(
      parseDelegateArgs({
        tasks: [task({ instructions: "x".repeat(length) })],
      }),
    );
    expect(error).toContain(
      `tasks[0].instructions is ${length.toLocaleString("en-US")} chars`,
    );
    expect(error).toContain("shorten it by at least 436 chars");
  });

  it("accepts the brief sizes the old 8,000-char cap rejected", () => {
    for (const length of [8436, 8489, 8833, 8916, 8810]) {
      expect(
        parseDelegateArgs({
          tasks: [task({ instructions: "x".repeat(length) })],
        }).ok,
        String(length),
      ).toBe(true);
    }
  });

  it(`rejects more than ${MAX_TASK_FILES} files and non-string entries`, () => {
    expect(
      expectError(
        parseDelegateArgs({
          tasks: [
            task({
              files: Array.from({ length: MAX_TASK_FILES + 1 }, () => "a"),
            }),
          ],
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
    expect(
      expectError(parseDelegateArgs({ tasks: [task()], maxWorkers: 0 })),
    ).toContain("at least 1");
    expect(
      parseDelegateArgs({ tasks: [task()], maxWorkers: 12 }),
    ).toMatchObject({
      ok: true,
      maxWorkers: 12,
    });
    expect(
      expectError(parseDelegateArgs({ tasks: [task()], maxWorkers: "2" })),
    ).toContain("must be a number");
    expect(
      parseDelegateArgs({ tasks: [task()], maxWorkers: 2.7 }),
    ).toMatchObject({
      ok: true,
      maxWorkers: 2,
    });
  });

  it("rejects a task that is not an object", () => {
    expect(
      expectError(parseDelegateArgs({ tasks: ["do the thing"] })),
    ).toContain("must be an object");
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
      expect(() =>
        parseDelegateArgs(raw as Record<string, unknown>),
      ).not.toThrow();
    }
  });
  it("accepts a task list that arrived as JSON text", () => {
    // What the text-JSON transport produces when the model quotes the
    // array: the plan is right, the quoting is not.
    const parsed = parseDelegateArgs({
      tasks: JSON.stringify([
        { id: "a", title: "A", instructions: "do a", files: ["/tmp/x/a.js"] },
      ]),
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks?.[0]?.id).toBe("a");
    expect(parsed.tasks?.[0]?.files).toEqual(["/tmp/x/a.js"]);
  });

  it("still refuses a string that is not a task list at all", () => {
    expect(parseDelegateArgs({ tasks: "build the thing" }).error).toMatch(
      /tasks must be an array/,
    );
    expect(parseDelegateArgs({ tasks: '{"id":"a"}' }).error).toMatch(
      /tasks must be an array/,
    );
  });
});

describe("parseDelegateArgs — contract", () => {
  const TASKS = [
    task({ id: "ship", files: ["js/ship.js"] }),
    task({ id: "html" }),
    task({ id: "main" }),
  ];
  const CONTRACT = {
    owners: { "index.html": "html", " js/main.js ": " main " },
    provides: [
      { task: "ship", kind: "symbol", name: "HD.Ship", in: "js/ship.js" },
      { task: "html", kind: "id", name: "btn-launch", in: "index.html" },
      { task: "ship", kind: "file", name: "js/hud.js" },
    ],
    requires: [{ task: "main", name: "HD.Ship" }],
    checks: [
      { task: "main", kind: "page", path: "index.html" },
      { kind: "command", cmd: "node", args: ["--check", "js/main.js"] },
    ],
  };

  it("carries a valid contract through, trimmed", () => {
    const parsed = parseDelegateArgs({ tasks: TASKS, contract: CONTRACT });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.contract).toEqual({
      owners: { "index.html": "html", "js/main.js": "main" },
      provides: CONTRACT.provides,
      requires: CONTRACT.requires,
      checks: CONTRACT.checks,
    });
  });

  it("accepts a contract that arrived as JSON text, like the task list", () => {
    const parsed = parseDelegateArgs({
      tasks: TASKS,
      contract: JSON.stringify(CONTRACT),
    });
    expect(parsed.ok && parsed.contract?.provides).toHaveLength(3);
  });

  it("omits an empty or null contract rather than carrying it", () => {
    for (const contract of [undefined, null, {}, { owners: {}, provides: [] }]) {
      const parsed = parseDelegateArgs({ tasks: TASKS, contract });
      expect(parsed.ok).toBe(true);
      expect(parsed).not.toHaveProperty("contract");
    }
  });

  it("names the field on every shape error", () => {
    const bad = (contract: unknown): string =>
      expectError(parseDelegateArgs({ tasks: TASKS, contract }));
    expect(bad("nonsense")).toContain("contract must be an object");
    expect(bad({ owners: [] })).toContain("contract.owners must be an object");
    expect(bad({ owners: { "": "ship" } })).toContain("contract.owners has an empty path");
    expect(bad({ owners: { "a.js": "nobody" } })).toBe(
      'validation: contract.owners["a.js"] names unknown task "nobody"',
    );
    expect(bad({ provides: {} })).toContain("contract.provides must be an array");
    expect(bad({ provides: ["x"] })).toContain("contract.provides[0] must be an object");
    expect(bad({ provides: [{ task: "ghost", kind: "file", name: "a" }] })).toContain(
      'contract.provides[0].task names unknown task "ghost"',
    );
    expect(bad({ provides: [{ task: "ship", kind: "class", name: "a" }] })).toContain(
      "contract.provides[0].kind must be one of symbol, file, id, endpoint, env, flag, other",
    );
    expect(bad({ provides: [{ task: "ship", kind: "file", name: " " }] })).toContain(
      "contract.provides[0].name must be a non-empty string",
    );
    expect(bad({ provides: [{ task: "ship", kind: "symbol", name: "a", in: 3 }] })).toContain(
      "contract.provides[0].in must be a non-empty path",
    );
    expect(bad({ requires: "x" })).toContain("contract.requires must be an array");
    expect(bad({ requires: [{ task: "ghost", name: "a" }] })).toContain(
      'contract.requires[0].task names unknown task "ghost"',
    );
    expect(bad({ checks: {} })).toContain("contract.checks must be an array");
    expect(bad({ checks: [{ task: "ghost", cmd: "x" }] })).toContain(
      'contract.checks[0].task names unknown task "ghost"',
    );
    expect(bad({ checks: [{ task: "main" }] })).toContain(
      "contract.checks[0] carries no verify.run arguments",
    );
  });

  it("rejects a require that no provide satisfies — the launch-btn / btn-launch mismatch, caught before any worker runs", () => {
    const error = expectError(
      parseDelegateArgs({
        tasks: TASKS,
        contract: {
          provides: [{ task: "html", kind: "id", name: "btn-launch", in: "index.html" }],
          requires: [{ task: "main", name: "launch-btn" }],
        },
      }),
    );
    expect(error).toBe(
      'validation: contract.requires[0].name "launch-btn" matches no provides entry (provided: btn-launch)',
    );
  });

  it("requires a place to look for a non-file provide", () => {
    // `html` owns nothing and declares no files: a symbol it "provides"
    // could only ever be reported unknown, so the brief is wrong now.
    expect(
      expectError(
        parseDelegateArgs({
          tasks: TASKS,
          contract: { provides: [{ task: "html", kind: "id", name: "x" }] },
        }),
      ),
    ).toContain(
      'contract.provides[0].in is required: task "html" owns no path and declares no files to look in',
    );
    // An owned path, a declared file, or `in` each satisfy it; a glob does not.
    for (const contract of [
      { owners: { "index.html": "html" }, provides: [{ task: "html", kind: "id", name: "x" }] },
      { provides: [{ task: "ship", kind: "symbol", name: "x" }] },
      { provides: [{ task: "html", kind: "id", name: "x", in: "index.html" }] },
      { provides: [{ task: "html", kind: "file", name: "index.html" }] },
    ]) {
      expect(parseDelegateArgs({ tasks: TASKS, contract }).ok).toBe(true);
    }
    expect(
      parseDelegateArgs({
        tasks: [task({ id: "g", files: ["js/**/*.js"] })],
        contract: { provides: [{ task: "g", kind: "symbol", name: "x" }] },
      }).ok,
    ).toBe(false);
  });

  it(`caps provides at ${MAX_CONTRACT_PROVIDES}, checks at ${MAX_CONTRACT_CHECKS} and the rendered block at ${MAX_CONTRACT_RENDERED_CHARS} chars`, () => {
    expect(
      expectError(
        parseDelegateArgs({
          tasks: TASKS,
          contract: {
            provides: Array.from({ length: MAX_CONTRACT_PROVIDES + 1 }, (_, i) => ({
              task: "ship",
              kind: "file",
              name: `f${i}`,
            })),
          },
        }),
      ),
    ).toContain(`contract.provides has ${MAX_CONTRACT_PROVIDES + 1} entries; at most ${MAX_CONTRACT_PROVIDES}`);
    expect(
      expectError(
        parseDelegateArgs({
          tasks: TASKS,
          contract: {
            checks: Array.from({ length: MAX_CONTRACT_CHECKS + 1 }, () => ({ cmd: "x" })),
          },
        }),
      ),
    ).toContain(`contract.checks has ${MAX_CONTRACT_CHECKS + 1} entries; at most ${MAX_CONTRACT_CHECKS}`);
    const error = expectError(
      parseDelegateArgs({
        tasks: TASKS,
        contract: {
          provides: Array.from({ length: 40 }, (_, i) => ({
            task: "ship",
            kind: "file",
            name: `${"p".repeat(240)}${i}`,
          })),
        },
      }),
    );
    expect(error).toMatch(/contract renders to [\d,]+ chars; the limit is 8,000 — shorten it by at least [\d,]+ chars/);
  });

  it("never throws on hostile contract input", () => {
    for (const contract of [
      { owners: null, provides: null, requires: null, checks: null },
      { provides: [null] },
      { provides: [{ task: {}, kind: [], name: 7 }] },
      { checks: [[]] },
      "{not json",
    ]) {
      expect(() => parseDelegateArgs({ tasks: TASKS, contract })).not.toThrow();
    }
  });
});
