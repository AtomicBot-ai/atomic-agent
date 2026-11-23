import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompletionResult, StreamChunk } from "../completion-types.js";
import {
  privacyVaultFor,
  resetPrivacyVaults,
  setPrivacyShieldEnabled,
} from "../../../privacy/index.js";
import { OpenAiProvider } from "./openai-provider.js";
import { createChunkUnmasker, maskOpenAiBody, unmaskCompletion } from "./openai-privacy-shield.js";

afterEach(() => resetPrivacyVaults());

const EMAIL = "jane.doe@example.com";
const CARD = "4111 1111 1111 1111";

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function contentFrame(content: string): string {
  return frame({
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
}

function toolArgsFrame(fragment: string, name?: string): string {
  return frame({
    model: "m",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(name ? { id: "call_1" } : {}),
              type: "function",
              function: { ...(name ? { name } : {}), arguments: fragment },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

const stopFrames = (reason = "stop") =>
  frame({ model: "m", choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + "data: [DONE]\n\n";

/** One SSE frame per pull, so every frame is its own chunk. */
function sse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const queue = [...frames];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function provider(fetchImpl: unknown, baseUrl = "https://api.example.invalid"): OpenAiProvider {
  return new OpenAiProvider({
    id: "cloud",
    baseUrl,
    apiKey: "",
    defaultChatModel: "m",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>, call = 0): string {
  return String((fetchImpl.mock.calls[call]?.[1] as RequestInit).body);
}

async function drain(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<{ chunks: StreamChunk[]; result: CompletionResult }> {
  const chunks: StreamChunk[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

describe("Privacy Shield helpers (ATO-1081)", () => {
  it("masks only the messages of a body and counts the request", () => {
    const vault = privacyVaultFor("s1");
    const body: Record<string, unknown> = {
      model: "m",
      messages: [{ role: "user", content: `mail ${EMAIL}` }],
      tools: [{ type: "function", function: { name: "send", description: `e.g. ${EMAIL}` } }],
    };
    maskOpenAiBody(body, vault);
    expect(body.messages).toEqual([{ role: "user", content: "mail [EMAIL_1]" }]);
    // Tool schemas are ours, not the person's.
    expect(JSON.stringify(body.tools)).toContain(EMAIL);
    expect(vault.stats().lastRequest).toBe(1);
  });

  it("unmasks reply, reasoning and tool-call arguments", () => {
    const vault = privacyVaultFor("s1");
    vault.mask(`${EMAIL} ${CARD}`);
    const result = {
      content: "Sent to [EMAIL_1].",
      reasoningContent: "card is [CARD_1]",
      toolCalls: [{ id: "c", type: "function", function: { name: "pay", arguments: '{"card":"[CARD_1]"}' } }],
    } as unknown as CompletionResult;
    const out = unmaskCompletion(result, vault);
    expect(out.content).toBe(`Sent to ${EMAIL}.`);
    expect(out.reasoningContent).toBe(`card is ${CARD}`);
    expect(JSON.parse(out.toolCalls![0]!.function.arguments)).toEqual({ card: CARD });
  });

  it("holds a placeholder split across chunks in both channels", () => {
    const vault = privacyVaultFor("s1");
    vault.mask(EMAIL);
    const unmasker = createChunkUnmasker(vault);
    const a = unmasker.push({ delta: "to [EMA", reasoningDelta: "[EMAIL", done: false });
    const b = unmasker.push({ delta: "IL_1]!", reasoningDelta: "_1", done: false });
    const tail = unmasker.flush();
    expect(a.delta + b.delta + (tail?.delta ?? "")).toBe(`to ${EMAIL}!`);
    expect(a.reasoningDelta + b.reasoningDelta + (tail?.reasoningDelta ?? "")).toBe("[EMAIL_1");
  });
});

describe("OpenAiProvider with Privacy Shield (ATO-1081)", () => {
  it("sends placeholders to a cloud endpoint and returns the real values (unary)", async () => {
    setPrivacyShieldEnabled(true);
    const fetchImpl = vi.fn(async () =>
      json({
        model: "m",
        choices: [
          {
            message: {
              content: "Done, wrote to [EMAIL_1].",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "mail", arguments: '{"to":"[EMAIL_1]"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const result = await provider(fetchImpl).complete({ prompt: `Email ${EMAIL} please`, sessionId: "s1" });
    const body = sentBody(fetchImpl);
    expect(body).not.toContain(EMAIL);
    expect(body).toContain("[EMAIL_1]");
    expect(result.content).toBe(`Done, wrote to ${EMAIL}.`);
    expect(JSON.parse(result.toolCalls![0]!.function.arguments)).toEqual({ to: EMAIL });
    expect(privacyVaultFor("s1").stats().distinct).toBe(1);
  });

  it("restores placeholders cut across stream chunks, in text and tool arguments", async () => {
    setPrivacyShieldEnabled(true);
    const fetchImpl = vi.fn(async () =>
      sse([
        contentFrame("Paying with [CA"),
        contentFrame("RD_1"),
        contentFrame("] for [EMAIL_"),
        contentFrame("1]"),
        toolArgsFrame('{"card":"[CAR', "pay"),
        toolArgsFrame('D_1]","to":"[EMAIL_1]"}'),
        stopFrames("tool_calls"),
      ]),
    );
    const { chunks, result } = await drain(
      provider(fetchImpl).completeStream({ prompt: `card ${CARD}, mail ${EMAIL}`, sessionId: "s1" }),
    );
    const body = sentBody(fetchImpl);
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("4111");
    const shown = chunks.map((c) => c.delta).join("");
    expect(shown).toBe(`Paying with ${CARD} for ${EMAIL}`);
    expect(shown).not.toContain("[");
    expect(result.content).toBe(`Paying with ${CARD} for ${EMAIL}`);
    expect(JSON.parse(result.toolCalls![0]!.function.arguments)).toEqual({ card: CARD, to: EMAIL });
  });

  it("releases text held back at the end of the stream", async () => {
    setPrivacyShieldEnabled(true);
    privacyVaultFor("s1").mask(EMAIL);
    const fetchImpl = vi.fn(async () =>
      sse([contentFrame("Mail: [EMAIL"), contentFrame("_1], see note [E"), stopFrames()]),
    );
    const { chunks, result } = await drain(
      provider(fetchImpl).completeStream({ prompt: "who?", sessionId: "s1" }),
    );
    // `[E` could have become a placeholder; it is shown once the stream ends.
    expect(chunks.map((c) => c.delta).join("")).toBe(`Mail: ${EMAIL}, see note [E`);
    expect(result.content).toBe(`Mail: ${EMAIL}, see note [E`);
  });

  it("masks the same value to the same placeholder on every request of a session", async () => {
    setPrivacyShieldEnabled(true);
    const reply = () =>
      json({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
    const fetchImpl = vi.fn(async () => reply());
    const p = provider(fetchImpl);
    await p.complete({ prompt: `a ${EMAIL}`, sessionId: "s1" });
    await p.complete({ prompt: `b ${EMAIL}`, sessionId: "s1" });
    expect(sentBody(fetchImpl, 0)).toContain("a [EMAIL_1]");
    expect(sentBody(fetchImpl, 1)).toContain("b [EMAIL_1]");
  });

  it("never masks for a server on this machine or the local network", async () => {
    setPrivacyShieldEnabled(true);
    for (const baseUrl of ["http://127.0.0.1:1234", "http://192.168.1.20:8080", "http://localhost:11434"]) {
      const fetchImpl = vi.fn(async () =>
        json({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
      );
      await provider(fetchImpl, baseUrl).complete({ prompt: `mail ${EMAIL}`, sessionId: "s1" });
      expect(sentBody(fetchImpl)).toContain(EMAIL);
    }
  });

  it("changes nothing while the shield is off", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ model: "m", choices: [{ message: { content: "[EMAIL_1]" }, finish_reason: "stop" }], usage: {} }),
    );
    const result = await provider(fetchImpl).complete({ prompt: `mail ${EMAIL}`, sessionId: "s1" });
    expect(sentBody(fetchImpl)).toContain(EMAIL);
    expect(result.content).toBe("[EMAIL_1]");
  });
});
