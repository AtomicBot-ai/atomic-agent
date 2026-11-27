import { afterEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { SlotManager } from "../llm/slot-manager.js";
import { ContextWindowTooSmallError } from "../llm/reliability/context-window-too-small.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import { fakeAnswer, fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { ToolDescriptor } from "../prompt/stable-prefix.js";
import type { StepContext, StepDependencies } from "../agent/step/step-contract.js";
import { prepareStepInference } from "../agent/step/step-inference.js";
import { completeOnLink, openStreamOnLink } from "./llm-link-attempt.js";

/**
 * ATO-1678, through the real attempt path: a local primary falls over to
 * a local link with a smaller window. The step's prompt carries no
 * `contextBudget` (only a cloud prompt sets one), so the link used to get
 * the primary's prompt unchecked and overflow. Now a smaller known window
 * rebuilds the prompt through `prepareForLink`, whose window check refuses
 * a link the tools alone fill.
 */

afterEach(() => resetConfigCache());

const BIG_SCHEMA = `{ ${Array.from({ length: 60 }, (_, i) => `field${i}: string`).join(", ")} }`;
const MANY_TOOLS: ToolDescriptor[] = Array.from({ length: 40 }, (_, i) => ({
  name: `mcp.server.tool_${i}`,
  summary: `Tool number ${i} from a connected MCP server, with a long description of what it does.`,
  argsSchema: BIG_SCHEMA,
}));

function localStep(): { ctx: StepContext; deps: StepDependencies } {
  return {
    ctx: {
      session: {
        ...createEmptySessionState({ id: "link-window-fit", workingDir: "/fixture" }),
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
      contextWindow: 262_144,
      profileWindowApplies: false,
      // Both links local: no provider entry marks either as cloud.
      modelModePolicy: { activeProviderId: "primary", providers: [] },
      modelMode: { mode: "local", source: "provider", providerId: "primary", modelId: null },
      llmComplete: async () => { throw new Error("not called"); },
    },
  };
}

function linkDeps(contextWindow: number) {
  const requests: CompletionRequest[] = [];
  const provider = fakeProvider("native_tools", "native_tools", async (request) => {
    requests.push(request);
    return fakeAnswer("native_tools");
  });
  return {
    requests,
    deps: { resolveSlice: () => ({ provider, transport: "native_tools" as const, contextWindow }) },
  };
}

describe("a local fallback link on a smaller window (ATO-1678)", () => {
  it("is refused before the request when the tools fill its window, unary and streamed", async () => {
    const { ctx, deps } = localStep();
    const { llmParams } = prepareStepInference(ctx, deps);
    expect(llmParams.contextBudget).toBeUndefined();
    const small = linkDeps(4096);
    await expect(completeOnLink(small.deps, llmParams, "small")).rejects.toBeInstanceOf(ContextWindowTooSmallError);
    await expect(openStreamOnLink(small.deps, llmParams, "small")).rejects.toBeInstanceOf(ContextWindowTooSmallError);
    expect(small.requests).toHaveLength(0);
  });

  it("keeps the prompt as built on a link with the same window", async () => {
    const { ctx, deps } = localStep();
    const { llmParams } = prepareStepInference(ctx, deps);
    const same = linkDeps(262_144);
    await completeOnLink(same.deps, llmParams, "primary");
    expect(same.requests).toHaveLength(1);
    expect(same.requests[0]?.prompt).toBe(llmParams.prompt);
  });
});
