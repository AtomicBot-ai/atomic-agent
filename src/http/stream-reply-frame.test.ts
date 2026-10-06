import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * Which reply text reaches a streaming client.
 *
 * Deltas stream the reply as the model writes it, and the step then emits
 * the whole reply once more as `assistant_reply`. The hook used to skip
 * every `assistant_reply` for the rest of the turn once any delta had
 * streamed — so a reply that never streams (the max-steps stop message, the
 * loop breaker's answer, a non-streamed retry) never reached the client,
 * and the turn read as cut off at whatever preamble had streamed last.
 */
describe("assistant replies over SSE", () => {
  const run = (events: unknown[]): string => {
    const content: string[] = [];
    const writer = {
      closed: false,
      writeEvent(_name: string | null, payload: unknown) {
        const c = (payload as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        if (typeof c === "string") content.push(c);
      },
    };
    const env = {
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled: false },
    } as never;
    const hook = buildStreamEventHook(writer as never, env);
    for (const e of events) hook(e as never);
    return content.join("");
  };
  const step = (stepIndex: number) => ({ type: "step_started", stepIndex });
  const delta = (text: string) => ({ type: "llm_event", event: { type: "assistant_delta", text } });
  const reply = (text: string) => ({ type: "llm_event", event: { type: "assistant_reply", text } });

  it("does not repeat a reply the step already streamed", () => {
    expect(run([step(0), delta("Hello, "), delta("world."), reply("Hello, world.")])).toBe("Hello, world.");
  });

  it("sends a reply that was never streamed, apart from the preamble before it", () => {
    const out = run([step(0), delta("Let me look."), step(1), reply("Here is the answer.")]);
    expect(out).toBe("Let me look.\n\nHere is the answer.");
  });

  it("sends the max-steps stop message after a streamed step", () => {
    const stop = "I stopped after 40 steps without finishing.";
    const out = run([step(0), delta("Checking the files first."), reply(stop)]);
    expect(out).toBe("Checking the files first.\n\n" + stop);
  });

  it("sends only the rest when a retry finishes what the stream began", () => {
    expect(run([step(0), delta("The build pas"), reply("The build passes on arm64.")])).toBe("The build passes on arm64.");
  });

  it("sends a reply as-is when nothing streamed", () => {
    expect(run([step(0), reply("Done.")])).toBe("Done.");
  });
});
