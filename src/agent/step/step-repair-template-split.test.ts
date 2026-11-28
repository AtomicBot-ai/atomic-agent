import { describe, expect, it } from "vitest";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { LlmStreamParams } from "./step-contract.js";
import { prepareStepRepair, type StepRepairArgs } from "./step-parsing.js";

/**
 * ATO-1676 (Sentry CLI-R6 / CLI-QX): on a grammar link that renders
 * through the model's own chat template, the provider sends
 * `head + chat.user + foot` and never reads `prompt`. The one-shot repair
 * rewrote `prompt` only, so the repair went out as the failed request
 * byte for byte and came back empty again.
 */
const TAIL = "### conversation\nuser: hi\n\n### respond\nRespond now.\n";

function repairArgs(llmParams: LlmStreamParams): StepRepairArgs {
  return {
    ctx: {
      session: createEmptySessionState({ id: "repair-template", workingDir: "/fixture" }),
      stepIndex: 0,
    } as unknown as StepRepairArgs["ctx"],
    deps: {
      profile: PLAIN_INSTRUCT_PROFILE,
      toolTransport: "grammar",
    } as unknown as StepRepairArgs["deps"],
    prompt: { text: `PREFIX\n${TAIL}` } as unknown as StepRepairArgs["prompt"],
    slot: { cacheReused: false },
    llmParams,
    grammarPrompt: undefined,
    promptCarriesPrefill: false,
    thinkingOff: false,
    replyCap: 2048,
    parsed: { ok: false, error: new Error("tool-call body is empty") },
    assumesOpenReasoning: () => false,
    onRetryReasoning: () => {},
  };
}

function baseParams(withChat: boolean): LlmStreamParams {
  return {
    prompt: `PREFIX\n${TAIL}`,
    slotId: -1,
    ...(withChat
      ? { chat: { system: "PREFIX", user: TAIL, prefixHash: "hash-1" } }
      : {}),
  } as unknown as LlmStreamParams;
}

describe("one-shot repair on the chat-template path", () => {
  it("carries the repair notice in chat.user, the part the provider renders", () => {
    const request = prepareStepRepair(repairArgs(baseParams(true))).buildRequest();
    expect(request.chat).toBeDefined();
    expect(request.chat!.user).not.toBe(TAIL);
    expect(request.chat!.user.startsWith(TAIL.trimEnd())).toBe(true);
    expect(request.chat!.user).toContain("### tool-call-repair");
    expect(request.chat!.user).toContain("reason: tool-call body is empty");
    expect(request.chat!.user).toContain("Emit a corrected JSON array only.");
  });

  it("keeps the stable prefix and its cache key untouched", () => {
    const request = prepareStepRepair(repairArgs(baseParams(true))).buildRequest();
    expect(request.chat!.system).toBe("PREFIX");
    expect(request.chat!.prefixHash).toBe("hash-1");
  });

  it("asks the same thing on both prompt shapes", () => {
    const request = prepareStepRepair(repairArgs(baseParams(true))).buildRequest();
    const notice = (text: string): string => text.slice(text.indexOf("### tool-call-repair"));
    expect(notice(request.chat!.user)).toBe(notice(request.prompt));
  });

  it("adds no chat parts to a request that had none", () => {
    const request = prepareStepRepair(repairArgs(baseParams(false))).buildRequest();
    expect(request.chat).toBeUndefined();
    expect(request.prompt).toContain("### tool-call-repair");
  });
});
