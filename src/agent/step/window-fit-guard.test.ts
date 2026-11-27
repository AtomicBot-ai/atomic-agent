import { afterEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { ContextWindowTooSmallError } from "../../llm/reliability/context-window-too-small.js";
import { classifyFailureCause } from "../../llm/reliability/classify-failure-cause.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import { prepareStepInference } from "./step-inference.js";
import { assertPromptFitsWindow, promptFixedTokens } from "./window-fit-guard.js";

/**
 * ATO-1678: a local window the instructions and native tool schemas
 * alone fill fails the step before the request, with words that name
 * the fix, instead of a reply cut after a few tokens every time.
 */

afterEach(() => resetConfigCache());

function tokens(parts: { total: number; conversation: number; toolSchema?: number }): BuiltPrompt["tokens"] {
  return {
    stablePrefix: 0, loadedSkills: 0, sessionFacts: 0, loadedTools: 0, profile: 0,
    worldSnapshot: 0, recalled: 0, memoryIndex: 0, taskPolicy: 0,
    ...parts,
  };
}

describe("assertPromptFitsWindow", () => {
  it("lets the Sentry event's prompt through: the fixed part leaves room", () => {
    // prefix 4323 + schemas 16 227 + 165 other, transcript 10 535.
    const prompt = { contextWindow: 32_768, tokens: tokens({ total: 31_250, conversation: 10_535, toolSchema: 16_227 }) };
    expect(promptFixedTokens(prompt.tokens)).toBe(20_715);
    expect(() => assertPromptFitsWindow(prompt, "local")).not.toThrow();
  });

  it("refuses a window the fixed part fills, naming the tools", () => {
    const prompt = { contextWindow: 16_384, tokens: tokens({ total: 16_000, conversation: 200, toolSchema: 12_000 }) };
    let thrown: unknown;
    try {
      assertPromptFitsWindow(prompt, undefined);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ContextWindowTooSmallError);
    const err = thrown as ContextWindowTooSmallError;
    expect(err.name).toBe("ContextWindowTooSmallError");
    expect(err.category).toBe("grammar");
    expect(err.fixedTokens).toBe(15_800);
    expect(err.message).toMatch(/16384 tokens/);
    expect(err.message).toMatch(/bigger context/);
    expect(err.message).toMatch(/MCP servers/);
    expect(err.message).not.toMatch(/\u2014/);
    expect(classifyFailureCause(err, err.category).cause).toBe("context_window_too_small");
  });

  it("does not judge a cloud prompt or an unknown window", () => {
    const full = tokens({ total: 40_000, conversation: 0, toolSchema: 30_000 });
    expect(() => assertPromptFitsWindow({ contextWindow: 16_384, tokens: full }, "cloud")).not.toThrow();
    expect(() => assertPromptFitsWindow({ contextWindow: null, tokens: full }, "local")).not.toThrow();
  });
});

const BIG_SCHEMA = `{ ${Array.from({ length: 60 }, (_, i) => `field${i}: string`).join(", ")} }`;
const MANY_TOOLS: ToolDescriptor[] = Array.from({ length: 40 }, (_, i) => ({
  name: `mcp.server.tool_${i}`,
  summary: `Tool number ${i} from a connected MCP server, with a long description of what it does.`,
  argsSchema: BIG_SCHEMA,
}));

function fixture(contextWindow: number): { ctx: StepContext; deps: StepDependencies } {
  return {
    ctx: {
      session: {
        ...createEmptySessionState({ id: "window-fit", workingDir: "/fixture" }),
        turns: [{ kind: "user", text: "do it", at: 1 }],
      },
      toolDescriptors: MANY_TOOLS,
      skillCatalog: [],
      capabilities: {
        platform: "win32", arch: "x64", browserChannel: "chrome",
        workingDir: "/fixture", hasClipboard: false, hasWmctrl: false,
        hasNotifications: false,
      },
      stepIndex: 1,
      signal: new AbortController().signal,
    },
    deps: {
      registry: new ToolRegistry(),
      slotManager: new SlotManager(1),
      profile: PLAIN_INSTRUCT_PROFILE,
      grammar: 'root ::= "fixture"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      contextWindow,
      profileWindowApplies: false,
      llmComplete: async () => { throw new Error("not called"); },
    },
  };
}

describe("a local native-tools step on a window its tools fill (ATO-1678)", () => {
  it("fails before the request with ContextWindowTooSmallError", () => {
    const { ctx, deps } = fixture(4096);
    expect(() => prepareStepInference(ctx, deps)).toThrow(ContextWindowTooSmallError);
  });

  it("prepares the same step on a window that holds the tools", () => {
    const { ctx, deps } = fixture(262_144);
    expect(() => prepareStepInference(ctx, deps)).not.toThrow();
  });

  it("refuses a fallback onto a link whose window the tools fill", () => {
    const { ctx, deps } = fixture(262_144);
    const primaryDeps: StepDependencies = {
      ...deps,
      modelModePolicy: { activeProviderId: "primary", providers: [] },
      modelMode: { mode: "local", source: "provider", providerId: "primary", modelId: null },
    };
    const prepared = prepareStepInference(ctx, primaryDeps);
    const linkMode = { mode: "local" as const, source: "provider" as const, providerId: "small", modelId: null };
    expect(() =>
      prepared.llmParams.prepareForLink!({ modelMode: linkMode, transport: "native_tools", contextWindow: 4096 }),
    ).toThrow(ContextWindowTooSmallError);
    expect(() =>
      prepared.llmParams.prepareForLink!({ modelMode: linkMode, transport: "native_tools", contextWindow: 262_144 }),
    ).not.toThrow();
  });
});
