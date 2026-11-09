import { describe, expect, it, vi } from "vitest";

import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  SPLIT_PROPOSAL_TAG,
  TaskTreeState,
  expandSplits,
  extractSplitProposal,
  hasSplitProposal,
  renderSplitInstructions,
  validateSplitProposal,
  type ExpandSplitsDeps,
  type SplitLimits,
} from "./task-tree.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

const fence = (body: unknown): string =>
  `I cannot finish this in one go.\n\`\`\`${SPLIT_PROPOSAL_TAG}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;

const PARENT: DelegateTask = {
  id: "build",
  title: "Build the game",
  instructions: "Build the whole game",
};

const LIMITS: SplitLimits = {
  depth: 1,
  maxDepth: 2,
  nodes: 1,
  maxNodes: 24,
  stepBudget: 40,
  timeBudgetMs: 600_000,
};

const TWO = [
  { id: "engine", instructions: "Write the engine" },
  { id: "ui", instructions: "Write the UI" },
];

function row(
  id: string,
  status: WorkerTaskStatus,
  reply = "done",
  over: Partial<WorkerTaskResult> = {},
): WorkerTaskResult {
  return {
    id,
    title: id,
    status,
    reply,
    stepCount: 2,
    durationMs: 10,
    tools: { calls: 1, errors: 0, writes: 1, byTool: { "os.fs.write": 1 } },
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    ...over,
  };
}

describe("extractSplitProposal", () => {
  it("finds nothing in an ordinary reply", () => {
    expect(extractSplitProposal("wrote src/a.ts")).toEqual({ found: false });
    expect(hasSplitProposal("wrote src/a.ts")).toBe(false);
  });

  it("reads the fenced JSON", () => {
    const reply = fence({ tasks: TWO });
    expect(hasSplitProposal(reply)).toBe(true);
    expect(extractSplitProposal(reply)).toEqual({
      found: true,
      raw: { tasks: TWO },
    });
  });

  it("names a block that is not JSON", () => {
    const out = extractSplitProposal(fence("{ tasks: nope"));
    expect(out.found).toBe(true);
    expect("error" in out && out.error).toMatch(/not valid JSON/);
  });
});

describe("validateSplitProposal", () => {
  it("namespaces ids under the parent, renames the contract and clamps budgets to the parent's", () => {
    const out = validateSplitProposal(
      {
        reason: "two separate modules",
        tasks: [
          { ...TWO[0], maxSteps: 500, timeoutMs: 5_000_000 },
          { ...TWO[1], maxSteps: 10 },
        ],
        contract: {
          provides: [{ task: "engine", kind: "symbol", name: "Engine", in: "src/engine.ts" }],
          requires: [{ task: "ui", name: "Engine" }],
          owners: { "src/engine.ts": "engine" },
        },
      },
      PARENT,
      LIMITS,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tasks.map((t) => t.id)).toEqual(["build/engine", "build/ui"]);
    expect(out.tasks[0]).toMatchObject({ maxSteps: 40, timeoutMs: 600_000 });
    expect(out.tasks[1]).toMatchObject({ maxSteps: 10, timeoutMs: 600_000 });
    expect(out.contract?.provides?.[0]?.task).toBe("build/engine");
    expect(out.contract?.requires?.[0]?.task).toBe("build/ui");
    expect(out.contract?.owners).toEqual({ "src/engine.ts": "build/engine" });
    expect(out.reason).toBe("two separate modules");
  });

  it("holds the subtasks to the delegate's own validation", () => {
    const out = validateSplitProposal(
      { tasks: [{ id: "a" }, { id: "b", instructions: "x" }] },
      PARENT,
      LIMITS,
    );
    expect(out).toEqual({
      ok: false,
      error: expect.stringMatching(/split proposal refused: validation: tasks\[0\]\.instructions/),
    });
  });

  it("refuses a split into fewer than two parts, an unknown key, and a non-object", () => {
    expect(
      validateSplitProposal({ tasks: [TWO[0]] }, PARENT, LIMITS),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/at least 2 subtasks/) });
    expect(
      validateSplitProposal({ tasks: TWO, plan: "x" }, PARENT, LIMITS),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/unknown key plan/) });
    expect(validateSplitProposal([TWO], PARENT, LIMITS).ok).toBe(false);
  });

  it("refuses a proposal from a node already at the depth limit", () => {
    const out = validateSplitProposal({ tasks: TWO }, PARENT, {
      ...LIMITS,
      depth: 2,
      maxDepth: 2,
    });
    expect(out).toMatchObject({
      ok: false,
      error: expect.stringMatching(/maxDepth 2/),
    });
  });

  it("refuses a proposal that would pass the node cap", () => {
    const out = validateSplitProposal({ tasks: TWO }, PARENT, {
      ...LIMITS,
      nodes: 23,
      maxNodes: 24,
    });
    expect(out).toMatchObject({
      ok: false,
      error: expect.stringMatching(/would make 25 nodes; the tree's limit is 24/),
    });
  });

  it("keeps the subtasks inside the parent's declared files", () => {
    const parent = { ...PARENT, files: ["src/engine.ts", "src/ui.ts"] };
    expect(
      validateSplitProposal(
        {
          tasks: [
            { ...TWO[0], files: ["./src/engine.ts"] },
            { ...TWO[1], files: ["src/ui.ts"] },
          ],
        },
        parent,
        LIMITS,
      ).ok,
    ).toBe(true);
    expect(
      validateSplitProposal(
        {
          tasks: [
            { ...TWO[0], files: ["src/engine.ts"] },
            { ...TWO[1], files: ["src/secret.ts"] },
          ],
        },
        parent,
        LIMITS,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/src\/secret\.ts, which is not one of the parent task's files/),
    });
  });
});

describe("TaskTreeState", () => {
  it("lets a node split only above the depth limit and with room for two more nodes", () => {
    const tree = new TaskTreeState({ maxDepth: 2, maxNodes: 4 }, "small");
    tree.addRoots([PARENT, { ...PARENT, id: "other" }], undefined);
    expect(tree.nodes).toBe(2);
    expect(tree.canSplitAt(1)).toBe(true);
    expect(tree.canSplitAt(2)).toBe(false);
    tree.addChildren("build", [{ ...PARENT, id: "build/a" }], undefined, "why");
    expect(tree.nodesLeft).toBe(1);
    expect(tree.canSplitAt(1)).toBe(false);
  });

  it("tells the worker how to propose, within the caps", () => {
    const text = renderSplitInstructions(5);
    expect(text).toContain("```" + SPLIT_PROPOSAL_TAG);
    expect(text).toContain("Between 2 and 5 subtasks");
  });
});

describe("expandSplits", () => {
  function setup(
    limits = { maxDepth: 2, maxNodes: 24 },
    runChildren: ExpandSplitsDeps["runChildren"] = async (tasks) =>
      tasks.map((t) => row(t.id, "ok", `did ${t.id}`)),
  ) {
    const tree = new TaskTreeState(limits, "small");
    tree.addRoots([PARENT], undefined);
    const spy = vi.fn(runChildren);
    const deps: ExpandSplitsDeps = {
      tree,
      workingDir: "/nonexistent-task-tree-test",
      workerMaxSteps: 40,
      workerTimeoutMs: 600_000,
      runChildren: spy,
    };
    return { tree, deps, spy };
  }

  it("leaves rows without a proposal untouched", async () => {
    const { deps, spy } = setup();
    const rows = [row("build", "ok")];
    expect(await expandSplits([PARENT], rows, deps)).toEqual(rows);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dispatches the children and closes the parent on them, with the tree in the report", async () => {
    const { deps, spy, tree } = setup();
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ reason: "too big", tasks: TWO }))],
      deps,
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0].map((t) => t.id)).toEqual([
      "build/engine",
      "build/ui",
    ]);
    // A child at the depth limit is told it is part of a bigger task, not how to split.
    const suffix = spy.mock.calls[0]?.[2]("build/engine") ?? "";
    expect(suffix).toContain("Part of a larger task");
    expect(suffix).not.toContain(SPLIT_PROPOSAL_TAG);
    expect(out?.status).toBe("ok");
    expect(out?.reply).toContain("Split by the worker into 2 subtasks (too big)");
    expect(out?.reply).toContain("[build/engine] ok");
    // The bill counts every node.
    expect(out?.usage?.promptTokens).toBe(300);
    expect(out?.tools.calls).toBe(3);
    const report = tree.report();
    expect(report).toMatchObject({ nodes: 3, splits: 1, rejected: 0 });
    expect(report.roots[0]).toMatchObject({
      id: "build",
      status: "ok",
      splitReason: "too big",
      depth: 1,
    });
    expect(report.roots[0]?.children.map((c) => [c.id, c.depth, c.parentId, c.status])).toEqual([
      ["build/engine", 2, "build", "ok"],
      ["build/ui", 2, "build", "ok"],
    ]);
  });

  it("knows each child's parent", async () => {
    const { deps, tree } = setup();
    await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(tree.parentOf("build/engine")).toBe("build");
    expect(tree.parentOf("build")).toBeUndefined();
  });

  it("hands the parent back to the orchestrator when a child did not close", async () => {
    const { deps } = setup(undefined, async (tasks) => [
      row(tasks[0]!.id, "ok"),
      row(tasks[1]!.id, "failed", "", { error: "provider died" }),
    ]);
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(out?.status).toBe("needs_orchestrator");
    expect(out?.error).toContain("build/ui (failed: provider died)");
  });

  it("fails the parent when every child delivered nothing, or a child-contract check with no owner failed", async () => {
    const { deps } = setup(undefined, async (tasks) =>
      tasks.map((t) => row(t.id, "failed", "", { error: "x" })),
    );
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(out?.status).toBe("failed");

    const second = setup();
    second.deps.evaluateChildren = async (rows) => ({
      rows,
      failedChecks: ["npm test failed"],
    });
    const [checked] = await expandSplits(
      [PARENT],
      [
        row(
          "build",
          "ok",
          fence({ tasks: TWO, contract: { checks: [{ command: "npm test" }] } }),
        ),
      ],
      second.deps,
    );
    expect(checked?.status).toBe("failed");
    expect(checked?.error).toContain("checks: npm test failed");
  });

  it("turns a refused proposal into a task for the orchestrator", async () => {
    const { deps, spy, tree } = setup();
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: [TWO[0]] }))],
      deps,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(out?.status).toBe("needs_orchestrator");
    expect(out?.error).toMatch(/split proposal refused: a split needs at least 2 subtasks/);
    expect(tree.report()).toMatchObject({ splits: 0, rejected: 1, nodes: 1 });
    expect(tree.report().roots[0]?.splitRejected).toMatch(/at least 2/);
  });

  it("refuses a proposal past the node cap without running anything", async () => {
    const { deps, spy } = setup({ maxDepth: 3, maxNodes: 2 });
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(out?.status).toBe("needs_orchestrator");
    expect(out?.error).toMatch(/limit is 2/);
  });

  it("expands a child's own proposal one level down at depth 3, and refuses one at the limit", async () => {
    const calls: string[][] = [];
    const { deps, tree } = setup({ maxDepth: 3, maxNodes: 24 }, async (tasks) => {
      calls.push(tasks.map((t) => t.id));
      return tasks.map((t) =>
        // Every depth-2 engine proposes; at depth 3 the same proposal is refused.
        t.id.endsWith("/engine")
          ? row(t.id, "ok", fence({ tasks: TWO }))
          : row(t.id, "ok", `did ${t.id}`),
      );
    });
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(calls).toEqual([
      ["build/engine", "build/ui"],
      ["build/engine/engine", "build/engine/ui"],
    ]);
    const engine = tree.report().roots[0]?.children[0];
    expect(engine?.children.map((c) => c.depth)).toEqual([3, 3]);
    expect(engine?.children[0]?.splitRejected).toMatch(/maxDepth 3/);
    // The refused grandchild did not close, so neither does the root.
    expect(out?.status).toBe("needs_orchestrator");
  });

  it("starts no split once the turn is stopped", async () => {
    const { deps, spy } = setup();
    deps.mayStart = () => false;
    const [out] = await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(out?.error).toMatch(/turn was stopped/);
  });

  it("keeps the fan-out's protected inputs on the children's contract", async () => {
    const { deps, spy } = setup();
    const parentContract: DelegateContract = { inputs: ["sales.csv"] };
    deps.parentContract = parentContract;
    await expandSplits(
      [PARENT],
      [row("build", "ok", fence({ tasks: TWO }))],
      deps,
    );
    expect(spy.mock.calls[0]?.[1]?.inputs).toEqual(["sales.csv"]);
  });
});
