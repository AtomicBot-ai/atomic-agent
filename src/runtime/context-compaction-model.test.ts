import { describe, expect, it, vi } from "vitest";
import { createCompactionDefaults } from "../config/agent/compaction-config.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { assistantReplyTurn, assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { prepareCompactionSource } from "./context-compaction-chunks.js";
import { summarizeWithModel, summaryRejection } from "./context-compaction-model.js";

function session(): SessionState {
  let state = createEmptySessionState({ id: "chat", workingDir: "/work" });
  for (const turn of [
    userTurn("REPORT ONE: list the freight orders"), assistantReplyTurn("Orders listed."),
    userTurn("REPORT TWO: check the invoices"),
    assistantToolCallTurn({ tool: "os.fs.read", args: { path: "/work/invoices.csv" } }),
    toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "invoice rows" }),
    assistantReplyTurn("Invoices checked."),
  ]) state = recordTurn(state, turn);
  return state;
}

function input(state: SessionState): BuildPromptInput {
  return { session: state, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    contextWindow: 12000, conversationMaxTokens: 4000, conversationMaxPairs: 200,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work", hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}

const completion: CompletionResult = { content: "Goal: report on freight orders and invoices.", reasoningContent: "", stop: true, truncated: false,
  timing: { promptTokens: 100, predictedTokens: 20, promptMs: 1, predictedMs: 1 }, cacheHitTokens: 0, slotId: -1, modelId: "test-model" };

async function requestFor(through: number): Promise<LlmStreamParams> {
  const state = session();
  const promptInput = input(state);
  const complete = vi.fn(async (_params: LlmStreamParams) => completion);
  await summarizeWithModel({
    input: promptInput, prompt: buildPrompt(promptInput),
    plan: { reason: "manual", from: 0, through, summaryMaxTokens: 250, targetTokens: 2000, tokensBefore: 3000 },
    config: { ...createCompactionDefaults(), mode: "model", summaryMaxTokens: 250 },
    route: { providerId: "current", transport: "grammar", serverTemplate: true },
    previous: "", source: prepareCompactionSource(state.turns, 0, through), signal: new AbortController().signal,
    tally: { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, calls: 0, chunkCount: 0, totalTimeoutMs: 0 },
    emit: () => {}, complete, sideCallSlotId: () => 3,
  });
  expect(complete).toHaveBeenCalledOnce();
  return complete.mock.calls[0]![0];
}

describe("model summary instructions", () => {
  it("marks a covered request whose answer continues after the cut", async () => {
    const afterRequest = await requestFor(3);
    expect(afterRequest.chat!.user).toContain("Record 2 is a user request that is still being handled after the covered records");
    const insideTurn = await requestFor(5);
    expect(insideTurn.chat!.user).toContain("Record 2 is a user request that is still being handled");
  });

  it("adds no such note when the cut follows an answer", async () => {
    const afterAnswer = await requestFor(2);
    expect(afterAnswer.chat!.user).not.toContain("still being handled");
  });

  it("asks for exact identifiers and no invented dates", async () => {
    const { chat } = await requestFor(2);
    expect(chat!.system).toContain("never generalize them into patterns or wildcards");
    expect(chat!.system).toContain("Do not add dates, years or times that do not appear in the records.");
  });
});

describe("model summary reply allowance", () => {
  it("leaves room to think beyond the summary target and asks the server not to think", async () => {
    const request = await requestFor(2);
    expect(request.maxTokens).toBeGreaterThan(250);
    expect(request.maxOutputTokens).toBe(request.maxTokens);
    expect(request.disableThinking).toBe(true);
    expect(request.reasoningEffort).toBe("low");
    expect(request.chat!.system).toContain("Keep the entire summary within 250 tokens.");
  });
});

describe("summaryRejection", () => {
  const reply = (patch: Partial<CompletionResult>): CompletionResult => ({ ...completion, ...patch });

  it("accepts a summary within its limit", () => {
    expect(summaryRejection(completion, completion.content, 250, 1000)).toBeNull();
  });

  it("says when the whole reply allowance went to thinking", () => {
    const message = summaryRejection(reply({ content: "", reasoningContent: "Let me think...", truncated: true, finishReason: "length" }), "", 250, 1000);
    expect(message).toContain("on thinking");
    expect(message).toContain("1000 tokens");
    expect(message).toContain("reasoningReserveTokens");
    expect(summaryRejection(reply({ content: "<think>still going", finishReason: "length" }), "", 250, 1000)).toContain("on thinking");
  });

  it("tells a cut summary, a thinking-only reply, an empty reply and an oversized summary apart", () => {
    expect(summaryRejection(reply({ finishReason: "length" }), completion.content, 250, 1000)).toContain("cut off");
    expect(summaryRejection(reply({ content: "<think>done</think>", reasoningContent: "" }), "", 250, 1000)).toBe("The model returned only thinking and no summary.");
    expect(summaryRejection(reply({ content: "" }), "", 250, 1000)).toBe("The model returned an empty summary.");
    const long = "word ".repeat(2000);
    expect(summaryRejection(reply({ content: long }), long, 250, 1000)).toContain("longer than its 250-token limit");
    expect(summaryRejection(reply({ toolCalls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] }), "x", 250, 1000)).toContain("tool calls");
  });
});
