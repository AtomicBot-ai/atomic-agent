import { describe, expect, it } from "vitest";

import {
  FUSION_WORKER_METADATA_KEY,
  createFusionWorkerSession,
} from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { getDefaultArgsJsonSchema } from "../../prompt/default-tool-args-schemas.js";
import { parseSubagentArgs } from "./subagent-args.js";
import {
  MintedSessionMetadata,
  SUBAGENT_MAX_CHILDREN_PER_CALL,
  SubagentTurnLedger,
  callerDepth,
} from "./subagent-limits.js";

describe("SubagentTurnLedger (ATO-1670)", () => {
  it("starts a new turn from 0 even when its first call lands at a higher step", () => {
    // Turn 1 calls at step 0; turn 2's first call is at step 1. Step
    // edges alone would read that as the same turn and count 3.
    const ledger = new SubagentTurnLedger();
    ledger.record("s", { turnId: "turn-1", stepIndex: 0 }, 3);
    expect(ledger.childrenThisTurn("s", { turnId: "turn-2", stepIndex: 1 })).toBe(0);
  });

  it("adds up calls within one turn", () => {
    const ledger = new SubagentTurnLedger();
    ledger.record("s", { turnId: "t1", stepIndex: 0 }, 2);
    ledger.record("s", { turnId: "t1", stepIndex: 3 }, 1);
    expect(ledger.childrenThisTurn("s", { turnId: "t1", stepIndex: 5 })).toBe(3);
  });

  it("drops the old turn's count once a new turn records", () => {
    const ledger = new SubagentTurnLedger();
    ledger.record("s", { turnId: "t1", stepIndex: 0 }, 4);
    ledger.record("s", { turnId: "t2", stepIndex: 0 }, 1);
    expect(ledger.childrenThisTurn("s", { turnId: "t2", stepIndex: 2 })).toBe(1);
    expect(ledger.childrenThisTurn("s", { turnId: "t1", stepIndex: 2 })).toBe(0);
  });

  it("falls back to step edges only without a turn id", () => {
    const ledger = new SubagentTurnLedger();
    ledger.record("s", { stepIndex: 2 }, 2);
    expect(ledger.childrenThisTurn("s", { stepIndex: 3 })).toBe(2);
    expect(ledger.childrenThisTurn("s", { stepIndex: 2 })).toBe(0);
  });

  it("keeps at most the given number of sessions", () => {
    const ledger = new SubagentTurnLedger(2);
    ledger.record("a", { turnId: "t", stepIndex: 0 }, 1);
    ledger.record("b", { turnId: "t", stepIndex: 0 }, 1);
    ledger.record("c", { turnId: "t", stepIndex: 0 }, 1);
    expect(ledger.size).toBe(2);
    expect(ledger.childrenThisTurn("a", { turnId: "t", stepIndex: 1 })).toBe(0);
    expect(ledger.childrenThisTurn("c", { turnId: "t", stepIndex: 1 })).toBe(1);
  });
});

describe("callerDepth (ATO-1670)", () => {
  it("is 0 for a real session and the stamp for a worker", () => {
    expect(callerDepth("s-real", undefined)).toBe(0);
    expect(callerDepth("s-real", {})).toBe(0);
    expect(
      callerDepth("s-w-1", {
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s", taskId: "t", depth: 2 },
      }),
    ).toBe(2);
  });

  it("reads the stamp even on an id without the worker prefix", () => {
    expect(
      callerDepth("s-odd", {
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s", taskId: "t", depth: 1 },
      }),
    ).toBe(1);
  });

  it("fails closed on a worker id whose stamp is missing or broken", () => {
    expect(callerDepth("s-w-1", undefined)).toBe(1);
    expect(callerDepth("s-w-1", { [FUSION_WORKER_METADATA_KEY]: 42 })).toBe(1);
  });
});

describe("MintedSessionMetadata", () => {
  it("answers with a minted worker session's own metadata", () => {
    const minted = new MintedSessionMetadata();
    const session = minted.remember(
      createFusionWorkerSession({
        workingDir: "/repo",
        meta: { parentSessionId: "s-1", taskId: "t", depth: 1 },
      }),
    );
    expect(callerDepth(session.id, minted.read(session.id))).toBe(1);
    expect(minted.read("s-unknown")).toBeUndefined();
  });

  it("forgets the oldest past its bound", () => {
    const minted = new MintedSessionMetadata(2);
    for (const id of ["a", "b", "c"]) {
      minted.remember(createEmptySessionState({ id, workingDir: "/repo", metadata: { id } }));
    }
    expect(minted.read("a")).toBeUndefined();
    expect(minted.read("b")).toEqual({ id: "b" });
    expect(minted.read("c")).toEqual({ id: "c" });
  });
});

describe("parseSubagentArgs", () => {
  it("accepts the taught keys and defaults the title", () => {
    const parsed = parseSubagentArgs({
      tasks: [{ id: "find_auth", instructions: "Find it.", profile: "explore", deliverable: "paths" }],
    });
    expect(parsed).toEqual({
      ok: true,
      tasks: [
        {
          id: "find_auth",
          title: "find auth",
          instructions: "Find it.",
          profile: "explore",
          deliverable: "paths",
        },
      ],
    });
  });

  it("refuses keys this tool does not teach, at the top and on a task", () => {
    const top = parseSubagentArgs({ tasks: [{ id: "a", instructions: "x" }], maxWorkers: 2 });
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.error).toContain("maxWorkers");
    const task = parseSubagentArgs({ tasks: [{ id: "a", instructions: "x", model: "m" }] });
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.error).toContain("model");
  });

  it("caps the task count per call, also when tasks arrive as a JSON string", () => {
    const many = Array.from({ length: SUBAGENT_MAX_CHILDREN_PER_CALL + 1 }, (_, i) => ({
      id: `t${i}`,
      instructions: "x",
    }));
    for (const tasks of [many, JSON.stringify(many)]) {
      const parsed = parseSubagentArgs({ tasks });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain(`at most ${SUBAGENT_MAX_CHILDREN_PER_CALL} subagents per call`);
      }
    }
  });

  it("refuses keys this tool does not teach when tasks arrive as a JSON string", () => {
    const parsed = parseSubagentArgs({
      tasks: JSON.stringify([{ id: "a", instructions: "x", maxSteps: 50 }]),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("maxSteps");
  });

  it("accepts files on a task", () => {
    const parsed = parseSubagentArgs({
      tasks: [{ id: "fix", instructions: "Fix it.", files: ["src/a.ts"] }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.tasks[0]!.files).toEqual(["src/a.ts"]);
  });

  it("refuses an empty or missing task list", () => {
    expect(parseSubagentArgs({ tasks: [] }).ok).toBe(false);
    expect(parseSubagentArgs({}).ok).toBe(false);
  });
});

describe("subagent.run args schema", () => {
  it("bounds the task list at the per-call cap, as the parser does", () => {
    const schema = getDefaultArgsJsonSchema("subagent.run") as {
      properties: { tasks: { minItems: number; maxItems: number } };
      required: string[];
    };
    expect(schema.properties.tasks.minItems).toBe(1);
    expect(schema.properties.tasks.maxItems).toBe(SUBAGENT_MAX_CHILDREN_PER_CALL);
    expect(schema.required).toEqual(["tasks"]);
  });

  it("teaches files on a task", () => {
    const schema = getDefaultArgsJsonSchema("subagent.run") as {
      properties: { tasks: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(schema.properties.tasks.items.properties)).toContain("files");
  });
});
