import { afterEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import { nativeToolSchemaTokens, prepareStepInference } from "./step-inference.js";

/**
 * ATO-1678: the `tools` array a native-tools link sends beside the text
 * is budgeted on a local link too, not only on a cloud one. Without it
 * a local Ollama / LM Studio / Fusion worker prompt was packed as if the
 * schemas took no room, and the reply ran into the end of the window.
 */

afterEach(() => resetConfigCache());

const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "os.fs.write",
    summary: "Write a file.",
    argsSchema: "{ path: string, content: string, mode?: \"overwrite\" | \"append\" }",
  },
  { name: "reply", summary: "Answer the user.", argsSchema: "{ text: string }" },
];

function fixture(transport: "native_tools" | "grammar"): { ctx: StepContext; deps: StepDependencies } {
  return {
    ctx: {
      session: {
        ...createEmptySessionState({ id: "schema-budget", workingDir: "/fixture" }),
        turns: [{ kind: "user", text: "write it", at: 1 }],
      },
      toolDescriptors: DESCRIPTORS,
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
      toolTransport: transport,
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      // No model mode: a local link, as every local provider resolves.
      contextWindow: 32_768,
      profileWindowApplies: false,
      llmComplete: async () => { throw new Error("not called"); },
    },
  };
}

describe("native tool schemas in the local step budget (ATO-1678)", () => {
  it("passes the tools array's size to a local native-tools prompt", () => {
    const { ctx, deps } = fixture("native_tools");
    const { prompt } = prepareStepInference(ctx, deps);
    const expected = nativeToolSchemaTokens(DESCRIPTORS, deps);
    expect(expected).toBeGreaterThan(0);
    expect(prompt.tokens.toolSchema).toBe(expected);
  });

  it("leaves a grammar link's budget without it", () => {
    const { ctx, deps } = fixture("grammar");
    const { prompt } = prepareStepInference(ctx, deps);
    expect(prompt.tokens.toolSchema).toBeUndefined();
  });
});
