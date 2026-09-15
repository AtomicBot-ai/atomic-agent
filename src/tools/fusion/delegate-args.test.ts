import { describe, expect, it } from "vitest";

import {
  MAX_CONTRACT_CHECKS,
  MAX_CONTRACT_PROVIDES,
  MAX_CONTRACT_RENDERED_CHARS,
} from "./contract.js";
import {
  humaniseTaskId,
  MAX_DELEGATE_TASKS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_REPORTED_PROBLEMS,
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

  it("rejects blank ids and instructions", () => {
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ id: "   " })] })),
    ).toContain("id must be a non-empty string");
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ instructions: null })] })),
    ).toContain("instructions must be a non-empty string");
  });

  it("defaults a missing title to the humanised id rather than refusing", () => {
    // Every task of one live call lacked `title`, and the refusal cost a
    // ~5 tok/s orchestrator four minutes of regeneration for a label.
    for (const over of [{}, { title: "" }, { title: "   " }, { title: 7 }]) {
      const parsed = parseDelegateArgs({
        tasks: [{ id: "fix_main_sync", instructions: "Fix it.", ...over }],
      });
      expect(parsed).toEqual({
        ok: true,
        tasks: [
          { id: "fix_main_sync", title: "fix main sync", instructions: "Fix it." },
        ],
      });
    }
    // A given title still wins.
    expect(
      parseDelegateArgs({ tasks: [task({ id: "fix_main_sync" })] }),
    ).toMatchObject({ tasks: [{ title: "Read the router" }] });
    expect(humaniseTaskId("fix-main-sync")).toBe("fix main sync");
    expect(humaniseTaskId("t1")).toBe("t1");
    expect(humaniseTaskId("___")).toBe("___");
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
      expectError(parseDelegateArgs({ tasks: [task({ files: ["a.ts", 1] })] })),
    ).toBe("validation: tasks[0].files[1] must be a non-empty string");
    expect(
      expectError(parseDelegateArgs({ tasks: [task({ files: "a.ts" })] })),
    ).toContain("must be an array");
  });

  it("reports every problem of the call in one message, not the first one met", () => {
    // Three consecutive refusals, one problem each, cost a local
    // orchestrator ~15 minutes before any worker ran. One message, one
    // regeneration.
    const error = expectError(
      parseDelegateArgs({
        tasks: [
          { id: "a", title: "A" },
          { id: "b", instructions: "do b", files: ["ok.js", 3] },
          { id: "a", instructions: "dup" },
        ],
        maxWorkers: 0,
        contract: {
          provides: [{ task: "ghost", kind: "file", name: "x" }],
          requires: [{ task: "b" }],
        },
      }),
    );
    expect(error).toBe(
      "validation: tasks[0].instructions must be a non-empty string; " +
        "tasks[1].files[1] must be a non-empty string; " +
        'tasks[2].id "a" is not unique; ' +
        "maxWorkers must be at least 1; " +
        'contract.provides[0].task names unknown task "ghost"; ' +
        "contract.requires[0].name must be a non-empty string",
    );
  });

  it("checks the contract against every id that parsed, so one broken task does not cascade", () => {
    // Task "a" lacks its instructions; a contract naming "a" is still
    // bound to it, not reported as "unknown task" on top.
    const error = expectError(
      parseDelegateArgs({
        tasks: [{ id: "a" }, task({ id: "b" })],
        contract: { owners: { "a.js": "a" }, provides: [{ task: "a", kind: "file", name: "a.js" }] },
      }),
    );
    expect(error).toBe("validation: tasks[0].instructions must be a non-empty string");
  });

  it(`spells out at most ${MAX_REPORTED_PROBLEMS} problems and counts the rest`, () => {
    const requires = Array.from({ length: MAX_REPORTED_PROBLEMS + 5 }, () => ({ task: "t1" }));
    const error = expectError(parseDelegateArgs({ tasks: [task()], contract: { requires } }));
    expect(error.split("; ")).toHaveLength(MAX_REPORTED_PROBLEMS + 1);
    expect(error).toMatch(/; … and 5 more problems$/);
  });

  it("still refuses what cannot run", () => {
    for (const raw of [
      { tasks: [] },
      { tasks: [task({ instructions: "" })] },
      { tasks: Array.from({ length: MAX_DELEGATE_TASKS + 1 }, (_, i) => task({ id: `t${i}` })) },
      { tasks: [task({ files: Array.from({ length: MAX_TASK_FILES + 1 }, () => "a") })] },
      { tasks: [task()], contract: "nonsense" },
      { tasks: [task()], contract: { provides: [{ task: "t1", kind: "class", name: "a" }] } },
    ]) {
      const result = parseDelegateArgs(raw as Record<string, unknown>);
      expect(result.ok, JSON.stringify(raw).slice(0, 80)).toBe(false);
      expect(expectError(result)).toMatch(/^validation: /);
    }
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

  it("carries a require that no provide satisfies through as a warning — the fan-out still runs", () => {
    // The launch-btn / btn-launch mismatch used to refuse the call. It
    // is still caught before any worker runs — as a note every worker
    // and the orchestrator read — but no longer at the price of a
    // regeneration; the workers can run without it.
    const parsed = parseDelegateArgs({
      tasks: TASKS,
      contract: {
        provides: [{ task: "html", kind: "id", name: "btn-launch", in: "index.html" }],
        requires: [{ task: "main", name: "launch-btn" }],
      },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.contract).toEqual({
      provides: [{ task: "html", kind: "id", name: "btn-launch", in: "index.html" }],
      requires: [{ task: "main", name: "launch-btn" }],
      warnings: ['requires "launch-btn" (task main) has no provider — nothing produces it'],
    });
  });

  it("carries a non-file provide with nowhere to look through as a warning — the fourth refusal of that afternoon", () => {
    // `html` owns nothing and declares no files: an id it "provides"
    // cannot be checked afterwards. The entry stays as declared; the
    // presence check skips it; everyone is told.
    const parsed = parseDelegateArgs({
      tasks: TASKS,
      contract: { provides: [{ task: "html", kind: "id", name: "x" }] },
    });
    expect(parsed.ok && parsed.contract).toEqual({
      provides: [{ task: "html", kind: "id", name: "x" }],
      warnings: ['provides "x" (task html) cannot be checked: no `in`, no owned path, no declared files'],
    });
    // An owned path, a declared file, or `in` each make it checkable; a glob does not.
    for (const contract of [
      { owners: { "index.html": "html" }, provides: [{ task: "html", kind: "id", name: "x" }] },
      { provides: [{ task: "ship", kind: "symbol", name: "x" }] },
      { provides: [{ task: "html", kind: "id", name: "x", in: "index.html" }] },
      { provides: [{ task: "html", kind: "file", name: "index.html" }] },
    ]) {
      const ok = parseDelegateArgs({ tasks: TASKS, contract });
      expect(ok.ok).toBe(true);
      expect(ok.ok && ok.contract).not.toHaveProperty("warnings");
    }
    const glob = parseDelegateArgs({
      tasks: [task({ id: "g", files: ["js/**/*.js"] })],
      contract: { provides: [{ task: "g", kind: "symbol", name: "x" }] },
    });
    expect(glob.ok && glob.contract?.warnings).toEqual([
      'provides "x" (task g) cannot be checked: no `in`, no owned path, no declared files',
    ]);
  });

  it("measures the rendered block with its warnings in it", () => {
    const parsed = parseDelegateArgs({
      tasks: TASKS,
      contract: { requires: [{ task: "main", name: "nothing" }] },
    });
    expect(parsed.ok && parsed.contract?.warnings).toHaveLength(1);
    // Every warning is a line the workers pay for; the cap counts them.
    const error = expectError(
      parseDelegateArgs({
        tasks: TASKS,
        contract: {
          requires: Array.from({ length: 40 }, (_, i) => ({ task: "main", name: `${"n".repeat(200)}${i}` })),
        },
      }),
    );
    expect(error).toMatch(/^validation: contract renders to [\d,]+ chars; the limit is 8,000/);
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
