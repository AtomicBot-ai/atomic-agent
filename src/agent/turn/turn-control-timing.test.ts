import { describe, expect, it } from "vitest";
import { ModelError, TransportError } from "../../llm/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { AgentLoop } from "../agent-loop.js";
import type { AgentLoopDependencies } from "../agent-contract.js";

function createLoop(overrides: Partial<AgentLoopDependencies>): AgentLoop {
  return new AgentLoop({
    registry: new ToolRegistry(),
    slotManager: new SlotManager(1),
    profile: PLAIN_INSTRUCT_PROFILE,
    grammar: 'root ::= "fixture"',
    toolTransport: "grammar",
    toolCallAdapter: null,
    supportsSlotAffinity: false,
    toolDescriptors: [],
    skillCatalog: [],
    capabilities: {
      platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/tmp",
      hasClipboard: false, hasWmctrl: false, hasNotifications: false,
    },
    llmComplete: async () => { throw new ModelError("empty", "fixture"); },
    ...overrides,
  });
}

describe("turn orchestration microtask boundaries", () => {
  it("closes a failed summary before the queued logger callback, preserving the original footer order", async () => {
    const order: string[] = [];
    const loop = createLoop({
      logger: new StructuredLogger({ level: "warn", sinks: [(record) => {
        if (record.message === "finalization step failed; preserving max-steps outcome") {
          order.push("final-guard");
          queueMicrotask(() => order.push("queued-from-final-guard"));
        }
      }] }),
      onEvent: (event) => {
        if (event.type === "loop_completed" || event.type === "turn_finished") order.push(event.type);
      },
      steeringInbox: { open() {}, drain: () => [], closeAndDrain: () => { order.push("close"); return []; } },
    });
    const result = await loop.runTurn(createEmptySessionState({ id: "timing", workingDir: "/tmp" }), {
      maxSteps: 1, autoContinue: false, signal: new AbortController().signal,
    });
    expect(result.reason).toBe("max_steps");
    expect(order).toEqual(["final-guard", "loop_completed", "turn_finished", "close", "queued-from-final-guard", "close"]);
  });

  it("finishes cancellation before a queued failure callback while retaining the same error", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const error = new TransportError("aborted transport", null, "fixture");
    const loop = createLoop({
      llmComplete: async () => { controller.abort(); throw error; },
      onEvent: (event) => {
        if (event.type === "loop_failed") {
          expect(event.error).toBe(error);
          order.push("failed");
          queueMicrotask(() => order.push("queued"));
        }
        if (event.type === "turn_finished") order.push("finished");
      },
      steeringInbox: { open() {}, drain: () => [], closeAndDrain: () => { order.push("close"); return []; } },
    });
    const result = await loop.runTurn(createEmptySessionState({ id: "cancel-timing", workingDir: "/tmp" }), {
      maxSteps: 1, autoContinue: false, signal: controller.signal,
    });
    expect(result.reason).toBe("cancelled");
    expect(order).toEqual(["failed", "finished", "close", "queued", "close"]);
  });
});
