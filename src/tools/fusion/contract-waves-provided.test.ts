import { describe, it, expect } from "vitest";
import {
  completedWaveNotes,
  PROVIDED_DETAIL_CHARS,
  providedList,
} from "./contract-waves.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * ATO-945: the run board a later wave reads. A provider's `PROVIDED:`
 * list sits at the end of its reply; the head-of-reply cut used to drop
 * exactly it, so a dependent knew its provider was "ok" and not what it
 * had exposed.
 */
const result = (over: Partial<WorkerTaskResult> = {}): WorkerTaskResult =>
  ({
    id: "phys",
    title: "js/bodies.js",
    status: "ok",
    reply: "done",
    stepCount: 3,
    durationMs: 1000,
    tools: { calls: 3, errors: 0 },
    ...over,
  }) as WorkerTaskResult;

const LONG_PROSE = "I wrote the physics module and checked its syntax. ".repeat(6);

describe("providedList", () => {
  it("reads a bulleted list after the header", () => {
    const reply = [
      LONG_PROSE,
      "",
      "PROVIDED:",
      "- symbol PHYS.corners js/bodies.js",
      "- file js/bodies.js",
    ].join("\n");
    expect(providedList(reply)).toBe(
      "symbol PHYS.corners js/bodies.js; file js/bodies.js",
    );
  });

  it("keeps an item written on the header line", () => {
    expect(providedList("ok\nPROVIDED: file js/hud.js")).toBe("file js/hud.js");
  });

  it("accepts markdown emphasis and numbered items", () => {
    const reply = "**PROVIDED:**\n1. id btn-launch index.html\n2) env PORT";
    expect(providedList(reply)).toBe("id btn-launch index.html; env PORT");
  });

  it("stops at the first blank line", () => {
    const reply = "PROVIDED:\n- file a.js\n\nNotes: something else";
    expect(providedList(reply)).toBe("file a.js");
  });

  it("uses the last header when the reply quotes the rule first", () => {
    const reply = [
      "The brief asked for a PROVIDED: list.",
      "",
      "PROVIDED:",
      "- file b.js",
    ].join("\n");
    expect(providedList(reply)).toBe("file b.js");
  });

  it("is undefined without a list, or with an empty one", () => {
    expect(providedList("wrote js/ship.js exporting Ship")).toBeUndefined();
    expect(providedList("PROVIDED:\n\nnothing")).toBeUndefined();
  });
});

describe("completedWaveNotes carries what a provider exposed", () => {
  it("shows the PROVIDED list even when the prose before it is long", () => {
    const reply = `${LONG_PROSE}\n\nPROVIDED:\n- symbol PHYS.corners js/bodies.js\n- symbol PHYS.step (renamed from PHYS.tick)`;
    const [note] = completedWaveNotes(new Map([["phys", result({ reply })]]));
    expect(note).toContain("[phys] ok");
    expect(note).toContain("provided symbol PHYS.corners js/bodies.js");
    // A name the worker changed is the line a dependent most needs.
    expect(note).toContain("renamed from PHYS.tick");
    expect(note).not.toContain("I wrote the physics module");
  });

  it("is bounded", () => {
    const items = Array.from({ length: 30 }, (_, i) => `- symbol A.b${i} js/a.js`);
    const reply = `PROVIDED:\n${items.join("\n")}`;
    const [note] = completedWaveNotes(new Map([["phys", result({ reply })]]));
    expect(note!.length).toBeLessThan(PROVIDED_DETAIL_CHARS + 80);
  });

  it("keeps the old note for a reply without a list", () => {
    const [note] = completedWaveNotes(
      new Map([["t1", result({ id: "t1", reply: "wrote js/ship.js exporting Ship" })]]),
    );
    expect(note).toContain("wrote js/ship.js exporting Ship");
    expect(note).not.toContain("provided");
  });

  it("does not read a failed task's reply as delivered", () => {
    const [note] = completedWaveNotes(
      new Map([
        [
          "phys",
          result({
            status: "failed",
            error: "check failed",
            reply: "PROVIDED:\n- file js/bodies.js",
          }),
        ],
      ]),
    );
    expect(note).toContain("[phys] failed: check failed");
    expect(note).not.toContain("provided");
  });
});
