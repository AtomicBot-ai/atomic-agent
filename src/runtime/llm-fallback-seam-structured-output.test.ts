import { describe, expect, it, vi } from "vitest";

import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import type {
  CompletionRequest,
  ResponseFormatJsonSchema,
} from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import {
  fakeAnswer,
  fakeProvider,
} from "../llm/provider/fake-provider.fixture.js";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { OPENROUTER_PARAMETER_REFUSAL_BODY } from "../llm/provider/openai/structured-output-refusal.fixture.js";
import {
  createFallbackCompleter,
  createFallbackStreamer,
  type FallbackSeamDeps,
} from "./llm-fallback-seam.js";

/**
 * The fallback chain is the reason the refusal is handled inside the
 * provider: every cloud `OpenAiHttpError` classifies `transport`, so a
 * refusal that escaped `complete` advanced the chain to the next link —
 * for a sub-call whose only defect was a field the endpoint lacks.
 */

const responseFormat: ResponseFormatJsonSchema = {
  name: "memory_votes",
  schema: { type: "object", properties: {}, additionalProperties: false },
};

const params = {
  prompt: "vote",
  grammar: 'root ::= "ok"',
  slotId: -1,
  sessionId: "s1",
  tools: [],
} as const;

function seamDeps(providers: Map<string, LlmProvider>) {
  const chain = new ProviderFallbackChain({
    resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }),
  });
  const advanceFrom = vi.spyOn(chain, "advanceFrom");
  const deps: FallbackSeamDeps = {
    fallbackChain: chain,
    resolveSlice: (providerId) => {
      const provider = providers.get(providerId)!;
      return { provider, transport: provider.capabilities.toolTransport };
    },
    recordUnaryUsage: () => {},
    recordStreamUsage: () => {},
  };
  return { deps, advanceFrom };
}

/** A real OpenAI-compatible cloud link: 404 refusal first, then a line-grammar answer. */
function refusingCloud(id: string) {
  const bodies: Array<Record<string, unknown>> = [];
  const replies = [
    () => new Response(OPENROUTER_PARAMETER_REFUSAL_BODY, { status: 404 }),
    () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "UPVOTE memory:12" }, finish_reason: "stop" },
          ],
        }),
        { status: 200 },
      ),
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return replies.shift()?.() ?? new Response("unexpected", { status: 418 });
  });
  const provider = new OpenAiProvider({
    id,
    baseUrl: "https://openrouter.example",
    apiKey: "k",
    defaultChatModel: "z-ai/glm-5.3-flash",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: { warn: () => {} },
  });
  return { provider, bodies };
}

describe("fallback seam — structured-output refusal", () => {
  it("serves a refused sub-call from the same cloud link without advancing the chain", async () => {
    // A unique provider id: the refusal memory is process-wide.
    const cloud = refusingCloud("cloud");
    const localServe = vi.fn(async () => fakeAnswer("local"));
    const { deps, advanceFrom } = seamDeps(
      new Map<string, LlmProvider>([
        ["cloud", cloud.provider],
        ["local", fakeProvider("local", "grammar", localServe)],
      ]),
    );

    const result = await createFallbackCompleter(deps)({ ...params, responseFormat });

    expect(result.content).toBe("UPVOTE memory:12");
    expect(result.servedTransport).toBe("native_tools");
    expect(cloud.bodies).toHaveLength(2);
    expect(cloud.bodies[1]).not.toHaveProperty("response_format");
    expect(advanceFrom).not.toHaveBeenCalled();
    expect(localServe).not.toHaveBeenCalled();
  });

  it("control: the same 404 on a request without responseFormat still advances the chain", async () => {
    // Proves the test above is not vacuous — this refusal body is one the
    // chain falls over on when nothing handles it.
    const { provider } = refusingCloud("cloud-control");
    const localServe = vi.fn(async () => fakeAnswer("local"));
    const { deps, advanceFrom } = seamDeps(
      new Map<string, LlmProvider>([
        ["cloud", provider],
        ["local", fakeProvider("local", "grammar", localServe)],
      ]),
    );

    const result = await createFallbackCompleter(deps)(params);

    expect(advanceFrom).toHaveBeenCalledTimes(1);
    expect(result.modelId).toBe("local-model");
  });

  it("never hands responseFormat to a streamed request, while the unary seam does", async () => {
    const seen: CompletionRequest[] = [];
    const serve = async (request: CompletionRequest) => {
      seen.push(request);
      return fakeAnswer("cloud");
    };
    const { deps } = seamDeps(
      new Map<string, LlmProvider>([
        ["cloud", fakeProvider("cloud", "native_tools", serve)],
        ["local", fakeProvider("local", "grammar", serve)],
      ]),
    );

    const stream = createFallbackStreamer(deps)({ ...params, responseFormat });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    await createFallbackCompleter(deps)({ ...params, responseFormat });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toHaveProperty("responseFormat");
    expect(seen[1]).toHaveProperty("responseFormat", responseFormat);
  });
});
