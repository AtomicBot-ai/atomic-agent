import { afterEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildPrompt } from "./build-prompt.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import type { CapabilitiesSummary, ToolDescriptor } from "./stable-prefix.js";
import { effectiveReplyReserve } from "./token-budget.js";

/**
 * ATO-1678: a local `native_tools` link (Ollama, LM Studio, a Fusion
 * worker leg) sends the tool schemas beside the prompt text, and the
 * window holds both. The local budget used to leave the schemas out, so
 * the transcript was packed into room they already took and the reply
 * hit the end of the window.
 */

afterEach(() => resetConfigCache());

function mkSession(): SessionState {
  return {
    ...createEmptySessionState({ id: "s", workingDir: "/work" }),
    turns: [{ kind: "user", text: "Write the report", at: 1 }],
  };
}

const TOOLS: ToolDescriptor[] = [
  { name: "finish", summary: "Signal goal completion.", argsSchema: "{ summary: string }" },
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

function localPrompt(toolSchemaTokens?: number) {
  return buildPrompt({
    session: mkSession(),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: [],
    profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 32_768 },
    completionMaxTokens: 4096,
    // Auto: the transcript takes exactly what the window leaves.
    conversationMaxTokens: 0,
    toolTransport: "native_tools",
    ...(toolSchemaTokens !== undefined ? { toolSchemaTokens } : {}),
  });
}

describe("local prompt budget with native tool schemas (ATO-1678)", () => {
  it("takes the schemas out of the conversation's room", () => {
    const without = localPrompt();
    const withSchemas = localPrompt(6_000);
    expect(without.conversationCapEffective - withSchemas.conversationCapEffective).toBe(6_000);
  });

  it("counts the schemas in the prompt total and reports them", () => {
    const without = localPrompt();
    const withSchemas = localPrompt(6_000);
    expect(withSchemas.tokens.toolSchema).toBe(6_000);
    expect(without.tokens.toolSchema).toBeUndefined();
    expect(withSchemas.tokens.total - without.tokens.total).toBe(6_000);
  });

  it("reports the reply reserve it held back", () => {
    expect(localPrompt().replyReserve).toBe(effectiveReplyReserve(4096, 32_768));
  });

  it("keeps the grammar budget as before when nothing is sent beside the text", () => {
    expect(localPrompt(0).conversationCapEffective).toBe(localPrompt().conversationCapEffective);
  });
});
