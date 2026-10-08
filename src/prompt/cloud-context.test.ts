import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState } from "../session/session-state.js";
import { userTurn, assistantToolCallTurn, toolResultTurn, assistantReplyTurn } from "../session/conversation-turn.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";
import { buildNativeMessages } from "../llm/provider/openai/openai-native-messages.js";
import { compactionBoundaryHash } from "../session/session-compaction.js";
import { planCompaction } from "./plan-compaction.js";
import { getConfig } from "../config/index.js";
import { readContextLengthFromRejection } from "../llm/reliability/request-size-rejection.js";
import { isNativeShapeRejection } from "../llm/provider/openai/openai-native-messages.js";

const mode = { mode: "cloud" as const, source: "provider" as const, providerId: "remote", modelId: "large" };
function fixture(): BuildPromptInput {
  const session = createEmptySessionState({ id: "cloud", workingDir: "/fixture" });
  session.turns = [userTurn("inspect", 1)];
  return { session, toolDescriptors: [], skillCatalog: [],
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    modelMode: mode, contextWindow: 200000, profileWindowApplies: false,
    toolTransport: "native_tools", suppressReasoningPrefill: true,
    tokenBudget: 1, conversationMaxTokens: 1, conversationMaxPairs: 1, sessionSectionsMaxTokens: 1,
    worldSnapshotMaxTokens: 1, loadedToolsMaxTokens: 1, recallMaxTokens: 1, profileMaxTokens: 1 };
}
const native = (prompt: ReturnType<typeof buildPrompt>) => buildNativeMessages(prompt.messages, { nameEscape: name => name });

describe("cloud message retention", () => {
  it("keeps full skills, results and state; appends updates after exactly the previous native history", () => {
    const input = fixture();
    const skill = "rules\n".repeat(3000) + "SKILL END";
    const result = "evidence\n".repeat(10000) + "RESULT END";
    input.session.loadedSkills = [{ name: "long", version: "1", body: skill, loadedAt: 1 }];
    input.session.worldSnapshot = { kind: "browser", digest: "v1", text: "ARIA\n".repeat(5000), capturedAt: 1 };
    input.session.turns.push(assistantToolCallTurn({ tool: "os.shell.run", args: {}, at: 2 }), toolResultTurn({ tool: "os.shell.run", status: "ok", summary: result, at: 3 }));
    const first = buildPrompt(input);
    expect(first.text).toContain(skill);
    expect(first.text).toContain(result);
    expect(first.text).toContain(input.session.worldSnapshot.text);
    expect(first.truncated).toBe(false);
    expect(input.session.cloudContext).toBeUndefined(); // pure preview
    input.session.cloudContext = first.cloudContext;
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("continue", 5));
    input.session.worldSnapshot = { ...input.session.worldSnapshot, digest: "v2", text: "new snapshot" };
    const second = buildPrompt(input);
    expect(native(second).slice(0, native(first).length)).toEqual(native(first));
    expect(second.text).toContain(result);
    expect(second.text.split(skill)).toHaveLength(2);
    expect(second.text).toContain("supersedes");
    input.session.cloudContext = second.cloudContext;
    expect(buildPrompt(input).cloudContext).toBe(second.cloudContext); // retry/unchanged state
    const restored = buildPrompt({ ...input, session: JSON.parse(JSON.stringify(input.session)) });
    expect(restored.text).toBe(second.text);
    expect(native(restored)).toEqual(native(second));
    const local = buildPrompt({ ...input, modelMode: { ...mode, mode: "local" } });
    expect(local.truncation.loadedSkills).toBe(true);
    expect(input.session.cloudContext).toBe(second.cloudContext);
    expect(buildPrompt(input).text).toBe(second.text);
  });

  it("does not duplicate a full skill.view result and retains it after a checkpoint", () => {
    const input = fixture();
    const body = "full instructions\n".repeat(2000) + "LAST RULE";
    input.session.loadedSkills = [{ name: "skill", version: "1", body, loadedAt: 1 }];
    input.session.turns.push(assistantToolCallTurn({ tool: "skill.view", args: { name: "skill" }, at: 2 }),
      toolResultTurn({ tool: "skill.view", status: "ok", summary: `# skill: skill (v1)\n${body}`, at: 3 }));
    const first = buildPrompt(input);
    expect(first.text.split(body)).toHaveLength(2);
    input.session.cloudContext = first.cloudContext;
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("continue", 5));
    input.session.compaction = { version: 1, summary: "Earlier work", coveredThrough: 4,
      boundaryHash: compactionBoundaryHash(input.session.turns[3]!), createdAt: 1, reason: "manual", model: null, tokensBefore: 10000, tokensAfter: 10 };
    const next = buildPrompt(input);
    expect(next.text).toContain(body);
    expect(next.text.split(body)).toHaveLength(2);
    expect(JSON.stringify(native(next))).not.toContain("no result recorded");
  });

  it("uses durable call ids across compaction and preserves grouped imported calls", () => {
    const input = fixture();
    input.session.turns.push(assistantReplyTurn("earlier", 2), userTurn("task", 3),
      assistantToolCallTurn({ tool: "a", args: {}, at: 4 }), assistantToolCallTurn({ tool: "b", args: {}, at: 5 }),
      toolResultTurn({ tool: "a", status: "ok", summary: "a result", at: 6 }), toolResultTurn({ tool: "b", status: "ok", summary: "b result", at: 7 }));
    const first = buildPrompt(input);
    input.session.cloudContext = first.cloudContext;
    input.session.compaction = { version: 1, summary: "Earlier work", coveredThrough: 2,
      boundaryHash: compactionBoundaryHash(input.session.turns[1]!), createdAt: 1, reason: "manual", model: null, tokensBefore: 100, tokensAfter: 10 };
    const next = native(buildPrompt(input));
    const calls = next.find(message => Array.isArray(message.tool_calls))?.tool_calls;
    expect(calls).toMatchObject([{ id: "call_turn_3" }, { id: "call_turn_4" }]);
    expect(JSON.stringify(next)).not.toContain("no result recorded");
  });

  it("does not compact because of the old pair or section caps", () => {
    const input = fixture();
    for (let i = 0; i < 10; i++) input.session.turns.push(assistantReplyTurn("done"), userTurn("more"));
    const prompt = buildPrompt(input);
    expect(prompt.droppedTurns).toBe(0);
    expect(planCompaction(input.session, prompt, getConfig().agent.compaction)).toBeNull();
  });

  it("checks schemas and final output overrides before sending, and marks the last cloud history message", () => {
    const input = fixture();
    const prompt = buildPrompt(input);
    const request = { prompt: prompt.text, messages: prompt.messages, modelMode: mode,
      contextBudget: { window: 16000, replyReserve: 1000 },
      tools: [{ type: "function", function: { name: "tool", parameters: { type: "object", properties: {} } } }] };
    const body = buildOpenAiChatBody(request, "model", false, undefined, undefined, true, undefined, { anthropicCacheControl: true });
    const messages = body.messages as Array<{ content: unknown }>;
    expect(messages[messages.length - 1]?.content).toMatchObject([{ cache_control: { type: "ephemeral" } }]);
    expect(body).not.toHaveProperty("contextBudget");
    expect(() => buildOpenAiChatBody(request, "model", false, { max_tokens: 16000 })).toThrow(/No content was truncated/);
    expect(() => buildOpenAiChatBody({ ...request, tools: [{ description: "schema".repeat(30000) }] }, "model", false)).toThrow(/context window/);
    try {
      buildOpenAiChatBody(request, "model", false, { max_tokens: 16000 });
      expect.fail("expected a capacity rejection");
    } catch (error) {
      expect(readContextLengthFromRejection(error)).toBe(16000);
      expect(isNativeShapeRejection(error)).toBe(false);
    }
    expect(() => buildOpenAiChatBody({ ...request, modelMode: { ...mode, mode: "local" } }, "model", false, { max_tokens: 16000 })).not.toThrow();
  });
});
