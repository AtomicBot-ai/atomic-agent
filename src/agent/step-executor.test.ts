import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { executeStep } from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
} from "../prompt/stable-prefix.js";

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

describe("executeStep rare tool autoload", () => {
  let grammarsDir: string;

  beforeEach(() => {
    grammarsDir = join(process.cwd(), "grammars");
  });

  it("injects loadedTools entry when a rare tool execution throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.git.show",
      description: "test",
      readonly: true,
      async run() {
        throw new Error("invalid args for test");
      },
    });
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args: Record<string, unknown>) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });

    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-auto", workingDir: "/w" });
    const completionBody = JSON.stringify({
      tool: "os.git.show",
      args: { revision: "HEAD" },
    });

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: completionBody,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );

    expect(outcome.toolResult.status).toBe("error");
    const names = outcome.nextSession.loadedTools.map((t) => t.name);
    expect(names).toContain("os.git.show");
    expect(
      outcome.nextSession.loadedTools.find((t) => t.name === "os.git.show")
        ?.source,
    ).toBe("auto");
  });
});
