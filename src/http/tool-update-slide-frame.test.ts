import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/** ATO-2444: a slide os.fs.write_pptx laid out rides its `tool_update` frame. */
describe("tool_update over SSE: slide", () => {
  const run = (event: Record<string, unknown>, extensionsEnabled = true) => {
    const written: Array<{ name: string | null; payload: Record<string, unknown> }> = [];
    const sse = {
      closed: false,
      writeEvent: (name: string | null, payload: unknown) => written.push({ name, payload: payload as Record<string, unknown> }),
    };
    const env = {
      completionId: "cmpl-1",
      created: 0,
      session: { id: "s-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    } as never;
    buildStreamEventHook(sse as never, env)(event as never);
    return written.filter((w) => w.name === "tool_update").map((w) => w.payload);
  };
  const slide = { index: 2, count: 12, layout: "bullets", title: "Goals", bullets: ["Ship"], moved: 0, theme: "light" };

  it("carries the slide next to the label", () => {
    const [frame] = run({ type: "tool_progress", tool: "os.fs.write_pptx", fraction: 0.25, elapsedMs: 12, label: "Slide 3 of 12 (bullets): Goals", slide });
    expect(frame).toMatchObject({ tool: "os.fs.write_pptx", fraction: 0.25, label: "Slide 3 of 12 (bullets): Goals", slide });
  });

  it("leaves it out for another tool's progress, and sends nothing without extensions", () => {
    const [frame] = run({ type: "tool_progress", tool: "video.generate", fraction: 0.5, elapsedMs: 1, label: "About 50%" });
    expect(frame).not.toHaveProperty("slide");
    expect(run({ type: "tool_progress", tool: "os.fs.write_pptx", fraction: 1, elapsedMs: 1, label: "x", slide }, false)).toEqual([]);
  });
});
