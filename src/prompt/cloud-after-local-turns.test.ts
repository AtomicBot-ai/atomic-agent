import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState } from "../session/session-state.js";
import { userTurn, assistantToolCallTurn, toolResultTurn, assistantReplyTurn } from "../session/conversation-turn.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";
import { PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../llm/model-profile.js";

/**
 * ATO-1575, part of ATO-352: Opus 5 through OpenRouter answered empty
 * twice after a long chat that ran on a local Qwen first. Hypothesis:
 * the local turns leave something in the cloud request that Anthropic
 * silently refuses. This builds the request the way a step does after
 * the route switched from a local thinking profile to OpenRouter's
 * `anthropic/claude-opus-5` in the same session, and checks the body.
 */
const THOUGHT = "ato-1575 local thinking that must stay local";
const local = { mode: "local" as const, source: "provider" as const, providerId: "local-llama", modelId: "qwen3.6-27b" };
const cloud = { mode: "cloud" as const, source: "provider" as const, providerId: "openrouter", modelId: "anthropic/claude-opus-5" };

function input(profile: typeof QWEN_THINK_PROFILE | typeof PLAIN_INSTRUCT_PROFILE): BuildPromptInput {
  const session = createEmptySessionState({ id: "s-1575", workingDir: "/fixture" });
  session.turns = [
    userTurn("list the files", 1),
    assistantToolCallTurn({ tool: "os.fs.list", args: { path: "." }, reasoning: THOUGHT, at: 2 }),
    toolResultTurn({ tool: "os.fs.list", status: "ok", summary: "a.txt\nb.txt", at: 3 }),
    assistantReplyTurn("Two files: a.txt and b.txt.", { at: 4, reasoning: THOUGHT }),
    userTurn("and now?", 5),
    // A reply that carried only reasoning (as imported sessions record held thinking).
    assistantReplyTurn("", { at: 6, reasoning: THOUGHT }),
    userTurn("summarise a.txt", 7),
    assistantToolCallTurn({ tool: "os.fs.read", args: { path: "a.txt" }, reasoning: THOUGHT, at: 8 }),
    toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "hello", at: 9 }),
  ];
  return {
    session, toolDescriptors: [], skillCatalog: [], profile,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    modelMode: local, contextWindow: 200000, profileWindowApplies: false,
  };
}

const TOOLS = [{ type: "function", function: { name: "reply", description: "reply", parameters: { type: "object", properties: {} } } }];

/** The local turns first, then the same session on the cloud route, as step-inference builds it for a native-tools link. */
function cloudBody(profile: typeof QWEN_THINK_PROFILE | typeof PLAIN_INSTRUCT_PROFILE) {
  const base = input(profile);
  buildPrompt({ ...base, toolTransport: "grammar" });
  const prompt = buildPrompt({ ...base, modelMode: cloud, toolTransport: "native_tools", suppressReasoningPrefill: true });
  // OpenRouter on api.openrouter.ai: no templateKwargs (not a local server), no reasoningRequired (not DeepSeek).
  return buildOpenAiChatBody(
    { prompt: prompt.text, messages: prompt.messages, tools: TOOLS as never, modelMode: cloud },
    "anthropic/claude-opus-5", true, undefined, undefined, undefined, undefined,
    { nameEscape: (name) => name, providerKind: "openrouter" },
  ) as { messages: Array<Record<string, unknown>> };
}

describe("a cloud request after local turns in the same session (ATO-1575)", () => {
  for (const profile of [QWEN_THINK_PROFILE, PLAIN_INSTRUCT_PROFILE]) {
    describe(profile.id, () => {
      it("sends no reasoning_content on assistant messages", () => {
        const { messages } = cloudBody(profile);
        expect(messages.some((m) => m["role"] === "assistant")).toBe(true);
        for (const m of messages) expect(m).not.toHaveProperty("reasoning_content");
        expect(JSON.stringify(messages)).not.toContain(THOUGHT);
      });

      it("does not end on a prefilled assistant message or carry the local template's markers", () => {
        const { messages } = cloudBody(profile);
        expect(messages.at(-1)!["role"]).not.toBe("assistant");
        const text = JSON.stringify(messages);
        for (const marker of ["<think>", "<|im_start|>", "<|im_end|>"]) expect(text).not.toContain(marker);
      });

      it("has no assistant message with empty text and no tool calls", () => {
        const { messages } = cloudBody(profile);
        const blank = messages.filter((m) => m["role"] === "assistant"
          && !(Array.isArray(m["tool_calls"]) && (m["tool_calls"] as unknown[]).length > 0)
          && (typeof m["content"] !== "string" || (m["content"] as string).trim().length === 0));
        expect(blank).toEqual([]);
      });
    });
  }
});
