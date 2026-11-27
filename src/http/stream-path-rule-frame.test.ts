import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/** ATO-2443: an attached path-scoped rule reaches an HTTP host (the desktop) as a named frame. */
describe("path_rule_attached over SSE", () => {
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
    hook({
      type: "llm_event",
      event: { type: "path_rule_attached", path: ".atomic-agent/rules/sql.md", patterns: ["*.sql"], stepIndex: 3 },
    } as never);
    return frames;
  };

  it("names the rule file and its patterns when extensions are on", () => {
    const frames = run(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.name).toBe("path_rule_attached");
    expect(frames[0]!.payload).toMatchObject({
      object: "chat.completion.path_rule_attached",
      session_id: "sess-1",
      step_index: 3,
      path: ".atomic-agent/rules/sql.md",
      patterns: ["*.sql"],
    });
  });

  it("stays off a plain OpenAI stream", () => {
    expect(run(false)).toEqual([]);
  });
});
