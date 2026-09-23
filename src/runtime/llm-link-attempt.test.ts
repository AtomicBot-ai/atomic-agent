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

function answer(request: CompletionRequest) {
  return Promise.resolve({
    content: "ok",
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: request.slotId ?? -1,
    modelId: null,
  });
}

function grammarLink(seen: CompletionRequest[]): {
  deps: { resolveSlice: (id: string) => { provider: LlmProvider; transport: "grammar" } };
} {
  const provider = fakeProvider("local", "grammar", async (request) => {
    seen.push(request);
    return answer(request);
  });
  return {
    deps: { resolveSlice: () => ({ provider, transport: "grammar" as const }) },
  };
}

const base = { prompt: "p", grammar: 'root ::= "ok"', sessionId: "s" };

describe("grammar request fields on a llama-server link", () => {
  it("sends cache_prompt for a pinned slot and not for a bare -1", async () => {
    const seen: CompletionRequest[] = [];
    const { deps } = grammarLink(seen);
    await completeOnLink(deps, { ...base, slotId: 2 }, "local");
    await completeOnLink(deps, { ...base, slotId: -1 }, "local");
    expect(seen.map((r) => [r.slotId, r.cachePrompt])).toEqual([
      [2, true],
      [-1, false],
    ]);
  });

  it("lets a pending main-loop request ask for cache_prompt on -1 (F13)", async () => {
    // `-1` + `cache_prompt: true` is how llama-server is told to pick the
    // slot by prefix similarity and keep the prompt there; a side call's
    // bare `-1` stays uncached.
    const seen: CompletionRequest[] = [];
    const { deps } = grammarLink(seen);
    await completeOnLink(
      deps,
      { ...base, slotId: -1, cachePrompt: true },
      "local",
    );
    const { primed } = await openStreamOnLink(
      deps,
      { ...base, slotId: -1, cachePrompt: true },
      "local",
    );
    // The provider was already called by the time the stream is primed;
    // drain what is left so the generator closes.
    for await (const _chunk of primed.rest) {
      // drain
    }
    expect(seen.map((r) => [r.slotId, r.cachePrompt])).toEqual([
      [-1, true],
      [-1, true],
    ]);
  });

  it("honours an explicit cache_prompt: false on a pinned slot", async () => {
    const seen: CompletionRequest[] = [];
    const { deps } = grammarLink(seen);
    await completeOnLink(
      deps,
      { ...base, slotId: 1, cachePrompt: false },
      "local",
    );
    expect(seen[0]?.cachePrompt).toBe(false);
  });
});
