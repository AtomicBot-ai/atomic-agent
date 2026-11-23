import { describe, expect, it, vi } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import { appendBatchedTurns } from "../agent/step/step-commit.js";
import { splitProgressNoteReply } from "../agent/progress-note-reply.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { openAiToolCallsToBatch } from "../llm/provider/openai/openai-tool-call-adapter.js";
import { normaliseOpenAiChatResponse } from "../llm/provider/openai/openai-normalise-response.js";
import { GeminiProvider } from "../llm/provider/gemini/gemini-provider.js";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";

/**
 * ATO-1680, part of ATO-1673: Gemini 3 signs each step's tool calls
 * (`extra_content.google.thought_signature`) and answers the next
 * request with a 400, "Function call is missing a thought_signature",
 * unless the signature comes back on that call. This runs a signed
 * Gemini response through the step's transcript and the cloud prompt
 * into the next request body, the way a two-step turn does.
 */
const SIG = "EpQCCpECAXLI2nx0uYq3w9k+Zb1c8vJ0qL6tH5nR2mS4pA==";
const cloud = { mode: "cloud" as const, source: "provider" as const, providerId: "gemini", modelId: "gemini-3-flash" };

/** Gemini's reply to step one: a progress note first, signed, then the work. */
const STEP_ONE = {
  model: "gemini-3-flash",
  choices: [{
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      tool_calls: [
        {
          id: "fn_1", type: "function",
          function: { name: "reply", arguments: '{"text":"Reading the file first."}' },
          extra_content: { google: { thought_signature: SIG } },
        },
        { id: "fn_2", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' } },
      ],
    },
  }],
};

function sessionAfterStepOne(): SessionState {
  let session = createEmptySessionState({ id: "s-1680", workingDir: "/fixture" });
  session = recordTurn(session, userTurn("summarise a.txt", 1));
  const batch = openAiToolCallsToBatch(normaliseOpenAiChatResponse(STEP_ONE, "gemini-3-flash").toolCalls!);
  // The signed call is the note, which the step takes out of the batch.
  const split = splitProgressNoteReply(batch.calls)!;
  expect(split.note.tool).toBe("reply");
  const results = split.calls.map(() =>
    compressToolResult({ tool: "os.fs.read", status: "ok", output: "hello" }));
  return appendBatchedTurns({ state: session, calls: split.calls, results, reasoning: "", terminal: null, modelMode: "cloud" });
}

function input(session: SessionState): BuildPromptInput {
  return {
    session, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    modelMode: cloud, contextWindow: 200000, profileWindowApplies: false,
    toolTransport: "native_tools", suppressReasoningPrefill: true,
  };
}

const TOOLS = [{ type: "function", function: { name: "os__fs__read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
const OK = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

function capturingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(OK), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

type SentCall = { function: { name: string }; extra_content?: unknown };
const sentCalls = (body: Record<string, unknown>): SentCall[] =>
  (body.messages as Array<Record<string, unknown>>).flatMap((m) => (m.tool_calls as SentCall[] | undefined) ?? []);

describe("a Gemini 3 thought signature survives into the next request (ATO-1680)", () => {
  it("is kept on the step's first recorded call, though it arrived on the note", () => {
    const calls = sessionAfterStepOne().turns.filter((t) => t.kind === "assistant_tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "os.fs.read", thoughtSignature: SIG });
  });

  it("goes back to Gemini on that call as extra_content.google.thought_signature", async () => {
    const prompt = buildPrompt(input(sessionAfterStepOne()));
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new GeminiProvider({ id: "gemini", apiKey: "k", fetchImpl, defaultChatModel: "gemini-3-flash" });
    await provider.complete({ prompt: prompt.text, messages: prompt.messages, tools: TOOLS as never, modelMode: cloud });
    const calls = sentCalls(bodies[0]!);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("os__fs__read");
    expect(calls[0]!.extra_content).toEqual({ google: { thought_signature: SIG } });
  });

  it("is not sent to a service that is not Gemini", async () => {
    const prompt = buildPrompt(input(sessionAfterStepOne()));
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new OpenAiProvider({
      id: "openai", baseUrl: "https://api.openai.com", apiKey: "k", defaultChatModel: "gpt-5", fetchImpl,
    });
    await provider.complete({ prompt: prompt.text, messages: prompt.messages, tools: TOOLS as never, modelMode: cloud });
    expect(sentCalls(bodies[0]!)).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).not.toContain("extra_content");
    expect(JSON.stringify(bodies[0])).not.toContain(SIG);
  });
});
