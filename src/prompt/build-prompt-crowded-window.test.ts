import { afterEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildPrompt } from "./build-prompt.js";
import { createEmptySessionState } from "../session/session-state.js";
import {
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../session/conversation-turn.js";
import type { CapabilitiesSummary, ToolDescriptor } from "./stable-prefix.js";
import { CONVERSATION_CAP_FLOOR } from "./token-budget.js";

/**
 * ATO-1678 (Sentry CLI-Q4, v0.10.0): window 32 768, tool schemas
 * 16 227, reply reserve 16 384. The fixed part and the full reserve
 * already passed the window, the cap clamped to 512, the pinned task
 * still went out at 10.5k and the reply got 265 tokens. Seam test of
 * `buildPrompt`: the reserve gives way and the transcript really fits.
 */

afterEach(() => resetConfigCache());

const WINDOW = 32_768;
const SCHEMAS = 16_227;

function longTask(calls: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [userTurn("collect the data from every page", 1)];
  for (let i = 0; i < calls; i += 1) {
    turns.push(
      assistantToolCallTurn({
        tool: "os.http.request",
        args: { url: `https://example.com/page/${i}`, method: "GET" },
        at: 2 + i * 2,
      }),
      toolResultTurn({
        tool: "os.http.request",
        status: "ok",
        summary: `page ${i} `.concat("word ".repeat(640)),
        at: 3 + i * 2,
      }),
    );
  }
  return turns;
}

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Answer the user.", argsSchema: "{ text: string }" },
];

const CAPS: CapabilitiesSummary = {
  platform: "win32",
  arch: "x64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

function crowdedPrompt() {
  return buildPrompt({
    session: {
      ...createEmptySessionState({ id: "crowded", workingDir: "/work" }),
      turns: longTask(12),
    },
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: [],
    profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: WINDOW },
    completionMaxTokens: 16_384,
    conversationMaxTokens: 0,
    toolTransport: "native_tools",
    suppressReasoningPrefill: true,
    toolSchemaTokens: SCHEMAS,
  });
}

describe("a local prompt on a window the tool schemas crowd (ATO-1678)", () => {
  it("shares the leftover: a smaller reply reserve, a transcript above the floor", () => {
    const prompt = crowdedPrompt();
    expect(prompt.replyReserve).toBeLessThan(16_384);
    expect(prompt.conversationCapEffective).toBeGreaterThan(CONVERSATION_CAP_FLOOR);
  });

  it("packs the pinned task within the transcript cap", () => {
    const prompt = crowdedPrompt();
    expect(prompt.tokens.conversation).toBeLessThanOrEqual(prompt.conversationCapEffective);
  });

  it("leaves the reply its reserve inside the window", () => {
    const prompt = crowdedPrompt();
    expect(prompt.tokens.toolSchema).toBe(SCHEMAS);
    expect(prompt.tokens.total + (prompt.replyReserve ?? 0)).toBeLessThanOrEqual(WINDOW);
  });
});
