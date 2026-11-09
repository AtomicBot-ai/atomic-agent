import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-483: when the person's fallback link answers, the turn says so in
 * one plain sentence. The desktop never saw `provider_switched` at all,
 * so a fallover there was silent.
 */
describe("provider_switched over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;
  const away = {
    type: "provider_switched" as const,
    direction: "away" as const,
    from: "openrouter",
    to: "gemini",
    reason: "OpenRouter is rate-limiting this key (429).",
    failure: "rate_limited" as const,
    toModel: "gemini-2.5-flash",
  };

  it("names what happened and who answered", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))(away as never);
    expect(sse.written).toEqual([
      {
        name: "provider_switched",
        payload: {
          object: "atomic.provider_switched",
          session_id: "sess-1",
          from: "openrouter",
          to: "gemini",
          to_model: "gemini-2.5-flash",
          cause: "rate_limited",
          notice: "OpenRouter is rate-limited, switched to Gemini (gemini-2.5-flash).",
          reason: away.reason,
        },
      },
    ]);
  });

  it("stays off the plain OpenAI stream, and a switch back is not announced", () => {
    const plain = makeSse();
    buildStreamEventHook(plain.writer as never, env(false))(away as never);
    expect(plain.written).toEqual([]);
    const back = makeSse();
    buildStreamEventHook(back.writer as never, env(true))({
      ...away,
      direction: "back",
      from: "gemini",
      to: "openrouter",
    } as never);
    expect(back.written).toEqual([]);
  });
});
