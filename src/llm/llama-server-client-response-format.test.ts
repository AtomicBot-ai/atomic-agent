import { describe, expect, it } from "vitest";

import type { CompletionRequest } from "./provider/completion-types.js";
import { LlamaServerClient } from "./llama-server-client.js";

/**
 * The memory sub-calls hand every request both a GBNF `grammar` and a
 * cloud `responseFormat`. On llama-server only the grammar applies: the
 * prompt must reach `/completion` byte-identical — the reflection slot's
 * KV cache is keyed on those bytes — and nothing JSON-related may leak
 * into the payload. The "mention json" instruction belongs to the cloud
 * body builder alone.
 */
describe("LlamaServerClient — a request that also carries responseFormat", () => {
  function captureBodies(): { client: LlamaServerClient; bodies: string[] } {
    const bodies: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({ content: "NONE", stop: true, truncated: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl,
    });
    return { client, bodies };
  }

  const request: CompletionRequest = {
    prompt: "You are a memory curator.\n\n### votes\n",
    grammar: 'root ::= "NONE"',
    slotId: 1,
  };

  it("sends the prompt and payload exactly as without it", async () => {
    const { client, bodies } = captureBodies();
    await client.complete(request);
    await client.complete({
      ...request,
      responseFormat: {
        name: "vote_runner_v1",
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    const payload = JSON.parse(bodies[1]!) as Record<string, unknown>;
    expect(payload.prompt).toBe(request.prompt);
    expect(payload.grammar).toBe(request.grammar);
    expect(payload).not.toHaveProperty("response_format");
  });
});
