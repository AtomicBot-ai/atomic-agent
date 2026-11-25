import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";
import { PROJECT_SECTION_MAX_TOKENS } from "../prompt/build-prompt.js";

/**
 * ATO-42: the local prompt's project block is told to an HTTP host (the
 * desktop) once per turn, with whether it was cut, so the chat can say so.
 */
describe("project_instructions over SSE", () => {
  const run = (extensionsEnabled: boolean, prompts: Array<Record<string, unknown>>) => {
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
    prompts.forEach((prompt, i) => {
      hook({ type: "step_started", stepIndex: i } as never);
      hook({ type: "llm_event", event: { type: "prompt_built", prompt, slotId: 0 } } as never);
    });
    return frames;
  };

  it("sends name, full token count and the cut once per turn", () => {
    const cut = { name: "Docs", tokens: 4200, truncated: true };
    const frames = run(true, [{ project: cut }, { project: cut }]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.name).toBe("project_instructions");
    expect(frames[0]!.payload).toMatchObject({
      object: "chat.completion.project_instructions",
      session_id: "sess-1",
      name: "Docs",
      tokens: 4200,
      truncated: true,
      max_tokens: PROJECT_SECTION_MAX_TOKENS,
    });
  });

  it("an uncut block is told with truncated false", () => {
    const frames = run(true, [{ project: { name: null, tokens: 12, truncated: false } }]);
    expect(frames[0]!.payload).toMatchObject({ name: null, tokens: 12, truncated: false });
  });

  it("nothing without a project block, and nothing on a plain OpenAI stream", () => {
    expect(run(true, [{}])).toEqual([]);
    expect(run(false, [{ project: { name: "Docs", tokens: 4200, truncated: true } }])).toEqual([]);
  });
});
