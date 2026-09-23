import { describe, expect, it } from "vitest";

import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import { ProviderFallbackChain } from "../llm/fallback/index.js";
import {
  fakeAnswer,
  fakeProvider,
} from "../llm/provider/fake-provider.fixture.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { QUERY_REWRITER_GRAMMAR } from "../memory/retrieve/query-rewriter-grammar.js";
import { QUERY_REWRITER_RESPONSE_FORMAT } from "../memory/retrieve/query-rewriter-response-format.js";
import {
  REWRITER_SLOT_ID,
  createQueryRewriterRunner,
} from "../memory/retrieve/query-rewriter-runner.js";
import { createAlwaysGate } from "../memory/retrieve/rewriter-gate.js";
import { createFallbackCompleter } from "./llm-fallback-seam.js";

/**
 * Regression: the query rewriter used to call the LLM under the bare
 * session id — the turn's own fallback partition. A provider that refuses
 * the rewriter's `response_format` request (404 "No endpoints found", a
 * Qwen 400) is advance-worthy, and the first advance-worthy failure sets
 * the partition's sticky override, so the user's next main step went to
 * the next link: usually a local llama-server nobody started, which died
 * `fetch failed` and failed the turn.
 *
 * Drives the REAL runner → seam → chain, so dropping the runner's
 * `rewriter:` prefix turns the first case red.
 */

const MESSAGE = "and what about it";

function harness() {
  let now = 1_000_000;
  const served: Array<{ link: string; sessionId: string | undefined }> = [];
  const chain = new ProviderFallbackChain({
    resolve: () => ({
      chain: ["cloud", "local-llama"],
      timing: DEFAULT_FALLBACK_TIMING,
    }),
    now: () => now,
  });
  const providers = new Map<string, LlmProvider>([
    [
      "cloud",
      fakeProvider("cloud", "native_tools", async (request) => {
        served.push({ link: "cloud", sessionId: request.sessionId });
        // Serves the agent loop, refuses the rewriter's structured output.
        if (request.responseFormat) {
          throw new OpenAiHttpError(
            "No endpoints found that support the requested parameters",
            404,
            "http://cloud",
            false,
            null,
            "cloud",
          );
        }
        return fakeAnswer("cloud");
      }),
    ],
    [
      "local-llama",
      fakeProvider("local-llama", "grammar", async (request) => {
        served.push({ link: "local-llama", sessionId: request.sessionId });
        throw new TypeError("fetch failed"); // no local model running
      }),
    ],
  ]);
  const complete = createFallbackCompleter({
    fallbackChain: chain,
    resolveSlice: (providerId) => {
      const provider = providers.get(providerId)!;
      return { provider, transport: provider.capabilities.toolTransport };
    },
    recordUnaryUsage: () => {},
    recordStreamUsage: () => {},
  });
  // Same adapter shape as bootstrap's `rewriterLlmComplete`.
  const runner = createQueryRewriterRunner({
    llmComplete: (p) =>
      complete({
        prompt: p.prompt,
        grammar: p.grammar,
        slotId: p.slotId,
        sessionId: p.sessionId,
        ...(p.responseFormat ? { responseFormat: p.responseFormat } : {}),
      }),
    timeoutMs: 1_000,
    gate: createAlwaysGate(),
  });
  return {
    chain,
    served,
    advance: (ms: number) => {
      now += ms;
    },
    complete,
    rewrite: () =>
      runner.maybeRewrite({
        sessionId: "s1",
        userMessage: MESSAGE,
        history: [{ role: "user", text: "compare Redis and memcached" }],
        signal: new AbortController().signal,
      }),
    mainStep: () =>
      complete({
        prompt: "main step",
        grammar: 'root ::= "ok"',
        slotId: 0,
        sessionId: "s1",
        tools: [],
      }),
  };
}

describe("fallback partition of the query rewriter (real runner + seam + chain)", () => {
  it("a provider refusing the rewriter never moves the turn's provider", async () => {
    const h = harness();
    // Two turns inside the 5-minute probe throttle: the second is where
    // the bare-id bug could no longer probe its way back to the primary.
    for (let turn = 0; turn < 2; turn += 1) {
      expect(await h.rewrite()).toBe(MESSAGE); // folded to the raw query
      await expect(h.mainStep()).resolves.toMatchObject({
        modelId: "cloud-model",
      });
      h.advance(60_000);
    }

    expect(h.chain.pickProvider("s1")).toEqual({
      providerId: "cloud",
      isProbe: false,
    });
    expect(h.chain.activeOverrideFor("s1")).toBeNull();
    expect(
      h.served.filter((s) => s.sessionId === "s1").map((s) => s.link),
    ).toEqual(["cloud", "cloud"]);
    // The refusal did land — on the rewriter's own partition.
    expect(h.chain.activeOverrideFor("rewriter:s1")).toBe("local-llama");
  });

  it("documents the defect: the same refusal on the bare session id flips the turn", async () => {
    const h = harness();
    const bareRewrite = () =>
      h
        .complete({
          prompt: "rewrite",
          grammar: QUERY_REWRITER_GRAMMAR,
          responseFormat: QUERY_REWRITER_RESPONSE_FORMAT,
          slotId: REWRITER_SLOT_ID,
          sessionId: "s1",
        })
        .catch(() => undefined);

    await bareRewrite();
    // First turn survives only because the primary is probed back once...
    await expect(h.mainStep()).resolves.toMatchObject({
      modelId: "cloud-model",
    });
    h.advance(60_000);
    await bareRewrite();
    // ...the next one is inside the probe throttle and lands on local.
    await expect(h.mainStep()).rejects.toThrow("fetch failed");

    expect(h.chain.activeOverrideFor("s1")).toBe("local-llama");
    expect(h.chain.pickProvider("s1")).toEqual({
      providerId: "local-llama",
      isProbe: false,
    });
  });
});
