import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { userTurn, assistantToolCallTurn, toolResultTurn } from "../session/conversation-turn.js";
import { recordProgressNote } from "../agent/progress-note-reply.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";
import { CONTINUE_AFTER_ASSISTANT } from "../llm/provider/openai/openai-native-messages.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";

/**
 * ATO-1681, part of ATO-1673: a step that batched `reply` with work
 * records the reply as a progress note after the step's tool pairs. A
 * cloud request has no tail, so the next step's request ended on that
 * note as an assistant message. Anthropic's newer models answer that
 * with a 400 ("does not support assistant message prefill. The
 * conversation must end with a user message"), and DeepSeek's thinking
 * mode refuses it too. This builds the request the way a step does after
 * a note and checks the body each service would get.
 */
const NOTE = "Found the config, reading it next.";

const cloud = (providerId: string, modelId: string) =>
  ({ mode: "cloud" as const, source: "provider" as const, providerId, modelId });

const ANTHROPIC = cloud("anthropic", "claude-sonnet-5");

/**
 * The step before the note built and committed its cloud context, as the
 * runtime does before inference; so the note's step adds no context
 * update of its own and the transcript decides what comes last.
 */
function sessionAfterNote(): SessionState {
  let session = createEmptySessionState({ id: "s-1681", workingDir: "/fixture" });
  session = recordTurn(session, userTurn("fix the build", 1));
  session = { ...session, cloudContext: buildPrompt(input(session, ANTHROPIC)).cloudContext };
  session = recordTurn(session, assistantToolCallTurn({ tool: "os.fs.list", args: { path: "." }, at: 2 }));
  session = recordTurn(session, toolResultTurn({ tool: "os.fs.list", status: "ok", summary: "build.json", at: 3 }));
  return recordProgressNote({
    state: session,
    note: { tool: "reply", args: { text: NOTE } },
    batchIndex: 1,
    batchSize: 2,
  }).state;
}

function input(session: SessionState, modelMode: ReturnType<typeof cloud>): BuildPromptInput {
  return {
    session, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    modelMode, contextWindow: 200000, profileWindowApplies: false,
    toolTransport: "native_tools", suppressReasoningPrefill: true,
  };
}

const TOOLS = [{ type: "function", function: { name: "reply", description: "reply", parameters: { type: "object", properties: {} } } }];

function body(
  session: SessionState,
  modelMode: ReturnType<typeof cloud>,
  options: { providerKind: string; reasoningRequired?: boolean; anthropicCacheControl?: boolean },
): Array<Record<string, unknown>> {
  const prompt = buildPrompt(input(session, modelMode));
  // The cloud projection has no tail: this is what made the note the last message.
  expect(prompt.messages?.tail).toBe("");
  const built = buildOpenAiChatBody(
    { prompt: prompt.text, messages: prompt.messages, tools: TOOLS as never, modelMode },
    modelMode.modelId, true, undefined, undefined, undefined, undefined,
    { nameEscape: (name) => name, ...options },
  ) as { messages: Array<Record<string, unknown>> };
  return built.messages;
}

describe("the cloud request after a progress note (ATO-1681)", () => {
  it("the projection itself ends on the note: the shape the services refused", () => {
    const turns = buildPrompt(input(sessionAfterNote(), ANTHROPIC)).messages!.turns;
    expect(turns.at(-1)).toEqual({ kind: "assistant_reply", text: NOTE });
  });

  it("Anthropic: does not end on the note as an assistant message", () => {
    const messages = body(sessionAfterNote(), ANTHROPIC, { providerKind: "anthropic" });
    const noteAt = messages.findIndex((m) => m["role"] === "assistant" && m["content"] === NOTE);
    expect(noteAt).toBeGreaterThan(0);
    expect(messages.at(-1)).toEqual({ role: "user", content: CONTINUE_AFTER_ASSISTANT });
    expect(messages.length - 1).toBe(noteAt + 1);
  });

  it("Anthropic: the cache breakpoint stays on the note, not on the request-only message", () => {
    const messages = body(sessionAfterNote(), ANTHROPIC, { providerKind: "anthropic", anthropicCacheControl: true });
    expect(messages.at(-1)).toEqual({ role: "user", content: CONTINUE_AFTER_ASSISTANT });
    expect(JSON.stringify(messages.at(-2))).toContain("cache_control");
    expect(JSON.stringify(messages.at(-2))).toContain(NOTE);
  });

  it("DeepSeek thinking: ends on user and the note carries reasoning_content", () => {
    const messages = body(sessionAfterNote(), cloud("deepseek", "deepseek-reasoner"),
      { providerKind: "openai-compatible", reasoningRequired: true });
    expect(messages.at(-1)!["role"]).toBe("user");
    const note = messages.find((m) => m["role"] === "assistant" && m["content"] === NOTE)!;
    expect(note["reasoning_content"]).toBe("");
    for (const m of messages.filter((x) => x["role"] === "assistant")) {
      expect(m).toHaveProperty("reasoning_content");
    }
  });

  it("drops the extra message once the next step's calls follow the note", () => {
    let session = sessionAfterNote();
    session = recordTurn(session, assistantToolCallTurn({ tool: "os.fs.read", args: { path: "build.json" }, at: 5 }));
    session = recordTurn(session, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "{}", at: 6 }));
    const messages = body(session, ANTHROPIC, { providerKind: "anthropic" });
    expect(messages.at(-1)!["role"]).toBe("tool");
    expect(messages.some((m) => m["content"] === CONTINUE_AFTER_ASSISTANT)).toBe(false);
  });
});
