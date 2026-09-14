import { describe, expect, it } from "vitest";

import type { LlmStreamParams } from "../agent/step-executor.js";
import type {
  CompletionRequest,
  PromptMessages,
} from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import {
  fakeAnswer,
  fakeProvider,
} from "../llm/provider/fake-provider.fixture.js";
import { completeOnLink, openStreamOnLink } from "./llm-link-attempt.js";

const messages: PromptMessages = {
  system: "prefix",
  droppedSummary: null,
  turns: [{ kind: "user", text: "hi" }],
  tail: "tail",
};

const params: LlmStreamParams = {
  prompt: "flat",
  messages,
  grammar: 'root ::= "ok"',
  slotId: 0,
  sessionId: "s1",
  tools: [{ type: "function", function: { name: "reply" } }],
};

function recording(transport: "native_tools" | "grammar") {
  const requests: CompletionRequest[] = [];
  const provider: LlmProvider = fakeProvider(
    transport,
    transport,
    async (request) => {
      requests.push(request);
      return fakeAnswer(transport);
    },
  );
  return { requests, provider };
}

describe("llm-link-attempt — the structured prompt", () => {
  it("reaches a native-tools link, unary and streamed", async () => {
    const { requests, provider } = recording("native_tools");
    const deps = { resolveSlice: () => ({ provider, transport: "native_tools" as const }) };
    await completeOnLink(deps, params, "native_tools");
    expect(requests[0]?.messages).toBe(messages);
    expect(requests[0]?.tools).toEqual(params.tools);

    const { primed } = await openStreamOnLink(deps, params, "native_tools");
    for (;;) if ((await primed.rest.next()).done) break;
    expect(requests[1]?.messages).toBe(messages);
  });

  it("never reaches a grammar link, which gets the flat prompt and the GBNF", async () => {
    const { requests, provider } = recording("grammar");
    const deps = { resolveSlice: () => ({ provider, transport: "grammar" as const }) };
    await completeOnLink(deps, params, "grammar");
    expect(requests[0]).not.toHaveProperty("messages");
    expect(requests[0]?.grammar).toBe(params.grammar);
    expect(requests[0]?.prompt).toBe("flat");
  });
});
