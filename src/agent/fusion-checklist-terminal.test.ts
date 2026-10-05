import { describe, expect, it, vi } from "vitest";
import { AgentLoop } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";

describe("Fusion checklist at the actual turn terminal", () => {
  it.each([
    { terminal: "reply", repair: false }, { terminal: "finish", repair: false },
    { terminal: "reply", repair: true }, { terminal: "finish", repair: true },
  ])("keeps $terminal fail-closed until a full pass (repair=$repair)", async ({ terminal, repair }) => {
    const registry = buildDefaultToolRegistry();
    const invoke = vi.spyOn(registry, "invoke");
    const blockedVerdicts = Array.from({ length: 16 }, (_, i) => `${String(i).padEnd(120, "x")}=${i === 15 ? "UNCHECKED" : i === 14 ? "FAIL" : "PASS"}`);
    const passedVerdicts = Array.from({ length: 16 }, (_, i) => `${String(i).padEnd(120, "x")}=PASS`);
    let delegations = 0;
    registry.register({ name: "fusion.delegate", description: "delegate", readonly: false,
      run: async () => {
        const passed = repair && ++delegations === 2;
        const verdict = "contract: checklist: " + (passed ? passedVerdicts : blockedVerdicts).join("; ");
        return ({
          tool: "fusion.delegate", status: passed ? "ok" : "error", truncated: false,
          summary: verdict,
          details: { checklistPassed: passed, checklistVerdict: verdict, tasks: [{ stepCount: 1 }] },
        });
      },
    });
    let step = 0;
    const replies: string[] = [];
    const loop = new AgentLoop({
      registry, slotManager: new SlotManager(1), grammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      profile: PLAIN_INSTRUCT_PROFILE, isFusionMode: () => true,
      llmComplete: async () => ({
        content: JSON.stringify([step++ < (repair ? 2 : 1)
          ? { tool: "fusion.delegate", args: { tasks: [] } }
          : { tool: terminal, args: terminal === "reply" ? { text: "SUCCESS_ALL_DONE", attachments: [] } : { summary: "SUCCESS_ALL_DONE" } }]),
        reasoningContent: "", stop: true, truncated: false,
        timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
        cacheHitTokens: 0, slotId: 0, modelId: "mock",
      } satisfies CompletionResult),
      toolDescriptors: [
        { name: "fusion.delegate", summary: "delegate", argsSchema: '{"tasks": array}' },
        { name: "reply", summary: "reply", argsSchema: '{"text": string}' },
        { name: "finish", summary: "finish", argsSchema: '{"summary": string}' },
      ],
      capabilities: { platform: "win32", arch: "x64", browserChannel: "chrome", workingDir: process.cwd(), hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      skillCatalog: [],
      onEvent: (event) => { if (event.type === "llm_event" && event.event.type === "assistant_reply") replies.push(event.event.text); },
    });
    const result = await loop.runTurn(createEmptySessionState({ id: "s-checklist", workingDir: process.cwd() }), {
      userMessage: "build the scenes", maxSteps: 4, autoContinue: false, signal: new AbortController().signal,
    });
    const transcript = JSON.stringify(result.session.turns);
    expect(invoke).toHaveBeenCalledWith(terminal, expect.objectContaining(
      terminal === "reply"
        ? { text: expect.stringContaining("SUCCESS_ALL_DONE"), attachments: [] }
        : { summary: expect.stringContaining("SUCCESS_ALL_DONE") },
    ), expect.anything());
    if (repair) {
      expect(transcript).toContain("SUCCESS_ALL_DONE");
      for (const verdict of passedVerdicts) expect(transcript).toContain(verdict);
      expect(result.reason).toBe(terminal);
      expect(result.session.status).not.toBe("failed");
      return;
    }
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    // Retain the model's claim for the operator, but never mark it accepted.
    expect(transcript).toContain("SUCCESS_ALL_DONE");
    expect(transcript).toContain("SUCCESS_ALL_DONE\\n\\nBehavior checklist blocked");
    expect(transcript).toContain("Behavior checklist blocked");
    for (const verdict of blockedVerdicts) expect(transcript).toContain(verdict);
    if (terminal === "reply") {
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("SUCCESS_ALL_DONE\n\nBehavior checklist blocked");
      expect(replies[0]).toContain(blockedVerdicts.at(-1));
    }
  });
});
