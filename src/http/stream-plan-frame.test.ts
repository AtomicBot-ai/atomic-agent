import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/** ATO-486: the live checklist reaches an HTTP host (the desktop) as a named frame. */
describe("plan_updated over SSE", () => {
  const run = (extensionsEnabled: boolean) => {
    const frames: Array<{ name: string | null; payload: Record<string, unknown> }> = [];
    const writer = {
      closed: false,
      writeEvent(name: string | null, payload: unknown) {
        frames.push({ name, payload: payload as Record<string, unknown> });
      },
    };
    const env = {
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    } as never;
    const hook = buildStreamEventHook(writer as never, env);
    hook({ type: "step_started", stepIndex: 2 } as never);
    hook({
      type: "llm_event",
      event: {
        type: "plan_updated",
        stepIndex: 2,
        plan: { items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }], updatedAt: 7 },
      },
    } as never);
    return frames;
  };

  it("sends the whole plan when extensions are on", () => {
    const frames = run(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.name).toBe("plan_updated");
    expect(frames[0]!.payload).toMatchObject({
      object: "chat.completion.plan_updated",
      session_id: "sess-1",
      step_index: 2,
      plan: { items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }], updatedAt: 7 },
    });
  });

  it("stays off a plain OpenAI stream", () => {
    expect(run(false)).toEqual([]);
  });
});
