import { describe, expect, it } from "vitest";
import { LlamaServerClient, LlamaServerError } from "./llama-server-client.js";
import { getConfig } from "../config/index.js";

/**
 * ATO-1675: an external llama server that refuses our GBNF grammar with a
 * 400 gets the request again without it, and every later request goes
 * out without it too. Our own engine keeps its refusal.
 */

type Sent = Record<string, unknown>;

/** llama.cpp's own body for a grammar its parser cannot read. */
const GRAMMAR_REFUSAL = JSON.stringify({
  error: { code: 400, message: "Failed to parse grammar", type: "invalid_request_error" },
});

const EXTERNAL = "http://127.0.0.1:8080";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A server that refuses any body carrying `grammar` and answers the rest. */
function refusingServer(
  baseUrl: string,
  sent: Sent[],
  answer: () => Response = () => json({ content: "hello", stop: true }),
): LlamaServerClient {
  return new LlamaServerClient({
    baseUrl,
    completionRetries: 1,
    progressWatch: false,
    fetchImpl: (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Sent;
      sent.push(body);
      if ("grammar" in body) {
        return new Response(GRAMMAR_REFUSAL, {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return answer();
    }) as typeof fetch,
  });
}

async function drain(
  stream: AsyncGenerator<{ delta: string }, unknown, void>,
): Promise<{ text: string; result: unknown }> {
  let text = "";
  for (;;) {
    const next = await stream.next();
    if (next.done) return { text, result: next.value };
    text += next.value.delta;
  }
}

describe("LlamaServerClient on a grammar refusal (ATO-1675)", () => {
  it("resends a refused completion without the grammar and says so", async () => {
    const sent: Sent[] = [];
    const client = refusingServer(EXTERNAL, sent);
    const result = await client.complete({ prompt: "p", grammar: 'root ::= "x"{0,3}' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveProperty("grammar");
    expect(sent[1]).not.toHaveProperty("grammar");
    expect(result.content).toBe("hello");
    expect(result.grammarSkipped).toBe(true);
  });

  it("remembers the refusal for that server: the next request goes out without the grammar", async () => {
    const sent: Sent[] = [];
    const client = refusingServer(EXTERNAL, sent);
    await client.complete({ prompt: "p", grammar: "root ::= x" });
    sent.length = 0;
    const result = await client.complete({ prompt: "p", grammar: "root ::= x" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("grammar");
    expect(result.grammarSkipped).toBe(true);
  });

  it("leaves a request with no grammar unmarked", async () => {
    const sent: Sent[] = [];
    const client = refusingServer(EXTERNAL, sent);
    await client.complete({ prompt: "p", grammar: "root ::= x" });
    const plain = await client.complete({ prompt: "p" });
    expect(plain.grammarSkipped).toBeUndefined();
  });

  it("keeps our own engine's refusal: one request, the 400 stands", async () => {
    const managed = `http://127.0.0.1:${getConfig().localModels.managed.port}`;
    const sent: Sent[] = [];
    const client = refusingServer(managed, sent);
    await expect(client.complete({ prompt: "p", grammar: "root ::= x" })).rejects.toMatchObject({
      name: "LlamaServerError",
      status: 400,
    });
    expect(sent).toHaveLength(1);
  });

  it("does not resend a 400 that is not about the grammar", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: EXTERNAL,
      completionRetries: 1,
      fetchImpl: (async () => {
        calls += 1;
        return json(
          { error: { code: 400, message: "the request exceeds the available context size", type: "invalid_request_error" } },
          400,
        );
      }) as typeof fetch,
    });
    await expect(client.complete({ prompt: "p", grammar: "root ::= x" })).rejects.toBeInstanceOf(
      LlamaServerError,
    );
    expect(calls).toBe(1);
  });

  it("throws the grammar refusal, not the resend's error, when the resend fails too", async () => {
    const sent: Sent[] = [];
    const client = refusingServer(EXTERNAL, sent, () => json({ error: "boom" }, 404));
    await expect(client.complete({ prompt: "p", grammar: "root ::= x" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Failed to parse grammar"),
    });
    expect(sent).toHaveLength(2);
  });

  it("forgets the refusal once the connection to that server is refused", async () => {
    const sent: Sent[] = [];
    let down = false;
    const client = new LlamaServerClient({
      baseUrl: EXTERNAL,
      completionRetries: 1,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        if (down) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          });
        }
        const body = JSON.parse(String(init?.body)) as Sent;
        sent.push(body);
        return "grammar" in body
          ? new Response(GRAMMAR_REFUSAL, { status: 400 })
          : json({ content: "ok", stop: true });
      }) as typeof fetch,
    });
    await client.complete({ prompt: "p", grammar: "root ::= x" });
    down = true;
    await expect(client.complete({ prompt: "p" })).rejects.toBeInstanceOf(LlamaServerError);
    down = false;
    sent.length = 0;
    await client.complete({ prompt: "p", grammar: "root ::= x" });
    // A new server may be newer: the grammar is offered again first.
    expect(sent[0]).toHaveProperty("grammar");
  });

  it("streams: a refused stream is opened again without the grammar", async () => {
    const sent: Sent[] = [];
    const client = refusingServer(EXTERNAL, sent, () =>
      sse(['data: {"content":"hi","stop":false}\n\n', 'data: {"content":"","stop":true}\n\n']),
    );
    const { text, result } = await drain(
      client.completeStream({ prompt: "p", grammar: "root ::= x" }),
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty("grammar");
    expect(text).toBe("hi");
    expect((result as { grammarSkipped?: boolean }).grammarSkipped).toBe(true);
  });

  it("streams: an older build's refusal as the first SSE event is resent too", async () => {
    const sent: Sent[] = [];
    const client = new LlamaServerClient({
      baseUrl: EXTERNAL,
      completionRetries: 1,
      progressWatch: false,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Sent;
        sent.push(body);
        return "grammar" in body
          ? sse([`data: ${GRAMMAR_REFUSAL}\n\n`])
          : sse(['data: {"content":"ok","stop":false}\n\n', 'data: {"content":"","stop":true}\n\n']);
      }) as typeof fetch,
    });
    const { text, result } = await drain(
      client.completeStream({ prompt: "p", grammar: "root ::= x" }),
    );
    expect(sent).toHaveLength(2);
    expect(text).toBe("ok");
    expect((result as { grammarSkipped?: boolean }).grammarSkipped).toBe(true);
  });

  it("streams: an error after text was yielded is never resent", async () => {
    const sent: Sent[] = [];
    const client = new LlamaServerClient({
      baseUrl: EXTERNAL,
      completionRetries: 1,
      progressWatch: false,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Sent);
        return sse(['data: {"content":"partial","stop":false}\n\n', `data: ${GRAMMAR_REFUSAL}\n\n`]);
      }) as typeof fetch,
    });
    await expect(
      drain(client.completeStream({ prompt: "p", grammar: "root ::= x" })),
    ).rejects.toBeInstanceOf(LlamaServerError);
    expect(sent).toHaveLength(1);
  });
});
