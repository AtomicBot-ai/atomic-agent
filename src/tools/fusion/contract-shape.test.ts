import { describe, it, expect } from "vitest";
import { completedWaveNotes } from "./contract-waves.js";
import type { WorkerTaskResult } from "./worker-result.js";
import {
  describeProvide,
  renderContractBlock,
  renderContractForTask,
  MAX_PROVIDE_SHAPE_CHARS,
} from "./contract.js";
import { parseDelegateArgs } from "./delegate-args.js";

/**
 * The break this exists to stop: two workers implemented `PHYS.corners(b)`
 * and both satisfied the NAME contract, while the producer returned
 * `{w: world, o: local offset}` and the consumer projected `o` as the
 * world point. Every box drew at the origin; nothing errored.
 */
const SHAPE = "corners(b) -> [{w:{x,y,z} world, o:{x,y,z} local offset}]";

const CONTRACT = {
  owners: { "js/bodies.js": "phys", "js/bodies-draw.js": "draw" },
  provides: [
    { task: "phys", kind: "symbol", name: "PHYS.corners", shape: SHAPE },
  ],
  requires: [{ task: "draw", name: "PHYS.corners" }],
};

describe("a provide carries its meaning, not just its name", () => {
  it("reaches the CONSUMER's brief — the half that has to agree about it", () => {
    const parsed = parseDelegateArgs({
      tasks: [
        { id: "phys", instructions: "write the physics" },
        { id: "draw", instructions: "write the renderer" },
      ],
      contract: CONTRACT,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.contract === undefined) return;
    const consumer = renderContractForTask(parsed.contract, "draw");
    expect(consumer).toContain("You may rely on:");
    expect(consumer).toContain(SHAPE);
    // Without it the consumer is told the symbol exists and nothing else.
    expect(consumer).toMatch(/PHYS\.corners.*world.*local offset/s);
  });

  it("shows up in the shared block too", () => {
    const parsed = parseDelegateArgs({
      tasks: [{ id: "phys", instructions: "x" }],
      contract: { provides: CONTRACT.provides },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.contract === undefined) return;
    expect(renderContractBlock(parsed.contract)).toContain(SHAPE);
  });

  it("renders exactly as before when no shape is given", () => {
    expect(describeProvide({ task: "t", kind: "symbol", name: "A.b" })).toBe(
      "symbol A.b",
    );
    expect(
      describeProvide({ task: "t", kind: "symbol", name: "A.b", in: "a.js" }),
    ).toBe("symbol A.b in a.js");
  });

  it("truncates a long shape instead of refusing the call", () => {
    const long = "x".repeat(MAX_PROVIDE_SHAPE_CHARS + 50);
    const parsed = parseDelegateArgs({
      tasks: [{ id: "phys", instructions: "x" }],
      contract: {
        provides: [{ task: "phys", kind: "symbol", name: "A.b", shape: long }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.contract === undefined) return;
    const shape = parsed.contract.provides![0]!.shape!;
    expect(shape.length).toBe(MAX_PROVIDE_SHAPE_CHARS);
    expect(shape.endsWith("…")).toBe(true);
  });

  it("refuses a shape that is not a string", () => {
    const parsed = parseDelegateArgs({
      tasks: [{ id: "phys", instructions: "x" }],
      contract: {
        provides: [{ task: "phys", kind: "symbol", name: "A.b", shape: 7 }],
      },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/shape must be a non-empty string/);
  });
});

describe("what a later wave is told about the waves before it", () => {
  const result = (over: Partial<WorkerTaskResult> = {}): WorkerTaskResult =>
    ({
      id: "t1",
      title: "js/ship.js",
      status: "ok",
      reply: "wrote js/ship.js exporting Ship",
      stepCount: 3,
      durationMs: 1000,
      tools: { calls: 3, errors: 0 },
      ...over,
    }) as WorkerTaskResult;

  it("says what succeeded, in the worker's own words", () => {
    const notes = completedWaveNotes(new Map([["t1", result()]]));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("[t1] ok");
    expect(notes[0]).toContain("wrote js/ship.js exporting Ship");
  });

  it("says why a failure failed, so a later worker can compensate", () => {
    const notes = completedWaveNotes(
      new Map([
        [
          "t3",
          result({
            id: "t3",
            status: "failed",
            error: "check failed: no #btn-launch",
          }),
        ],
      ]),
    );
    expect(notes[0]).toContain("[t3] failed");
    expect(notes[0]).toContain("no #btn-launch");
  });

  it("says nothing before anything has finished", () => {
    expect(completedWaveNotes(new Map())).toEqual([]);
  });

  it("is bounded — a brief is not a history of the fan-out", () => {
    const many = new Map(
      Array.from({ length: 20 }, (_, i) => [
        `t${i}`,
        result({ id: `t${i}`, reply: "x".repeat(500) }),
      ]),
    );
    const notes = completedWaveNotes(many);
    expect(notes.length).toBeLessThanOrEqual(8);
    for (const note of notes) expect(note.length).toBeLessThan(200);
  });
});
