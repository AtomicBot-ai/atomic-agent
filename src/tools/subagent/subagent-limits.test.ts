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
  callerDepth,
} from "./subagent-limits.js";

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
});
