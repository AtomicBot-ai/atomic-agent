import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState } from "../session/session-state.js";
import { userTurn, assistantToolCallTurn, toolResultTurn, assistantReplyTurn } from "../session/conversation-turn.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";

function fixture(): BuildPromptInput {
  const session = createEmptySessionState({ id: "baseline", workingDir: "/fixture" });
  session.loadedSkills = [{ name: "large-skill", version: "1", body: "Important instructions.\n".repeat(500), loadedAt: 1 }];
  session.turns = [userTurn("inspect", 1), assistantToolCallTurn({ tool: "os.shell.run", args: { command: "check" }, at: 2 }), toolResultTurn({ tool: "os.shell.run", status: "ok", summary: "evidence\n".repeat(1600), at: 3 })];
  return {
    session, capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    toolDescriptors: [], skillCatalog: [], contextWindow: 200000,
    tokenBudget: 3000, sessionSectionsMaxTokens: 0, toolTransport: "native_tools", suppressReasoningPrefill: true,
  };
}

describe("model mode compatibility", () => {
  it("keeps local prompt bytes, budgets and legacy aging unchanged", () => {
    const input = fixture();
    const legacy = buildPrompt(input);
    const modelMode = { mode: "local" as const, source: "provider" as const, providerId: "local", modelId: "model" };
    const local = buildPrompt({ ...input, modelMode });
    const { modelMode: diagnostic, ...rendered } = local;
    expect(rendered).toEqual(legacy);
    expect(diagnostic).toEqual(modelMode);
    expect(local.limits.session).toBe(450);
    expect(local.truncation.loadedSkills).toBe(true);
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("continue", 5));
    const next = buildPrompt({ ...input, modelMode });
    const body = (p: typeof next) => p.messages.turns.find(t => t.kind === "tool_result");
    expect(body(local)).toMatchObject({ body: expect.any(String) });
    const fresh = body(local); const old = body(next);
    if (fresh?.kind !== "tool_result" || old?.kind !== "tool_result") throw new Error("missing result");
    expect(fresh.body.length).toBeGreaterThan(7000);
    expect(old.body.length).toBeLessThanOrEqual(400);
  });

  it("keeps full cloud content without sending policy metadata to the API", () => {
    const input = fixture();
    const legacy = buildPrompt(input);
    const modelMode = { mode: "cloud" as const, source: "model" as const, providerId: "remote", modelId: "model" };
    const { modelMode: diagnostic, ...cloud } = buildPrompt({ ...input, modelMode });
    expect(cloud.truncated).toBe(false);
    expect(cloud.text).toContain(input.session.loadedSkills[0]!.body);
    const result = cloud.messages.turns.find(t => t.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.body).toBe("evidence\n".repeat(1600));
    expect(diagnostic?.mode).toBe("cloud");
    const request = { prompt: legacy.text, modelMode };
    const body = buildOpenAiChatBody(request, "model", false);
    expect(body).not.toHaveProperty("modelMode");
    expect(body).toEqual(buildOpenAiChatBody({ prompt: legacy.text }, "model", false));
  });
});
