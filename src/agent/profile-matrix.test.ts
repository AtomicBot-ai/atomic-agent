import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "./agent-loop.js";
import type { StepEvent } from "./step-executor.js";
import {
  GEMMA4_PROPS,
  GPT_OSS_PROPS,
  LLAMA3_PROPS,
  NEMOTRON_PROPS,
  QWEN3_PROPS,
} from "../llm/model-profile.fixtures.js";
import { startTestHarness } from "../http/test-harness.js";
import type { LogRecord } from "../tracing/structured-logger.js";

const FINAL_COMPLETION = {
  content: "",
  reasoningContent: "",
  stop: true,
  truncated: false,
  timing: {
    promptMs: 0,
    predictedMs: 0,
    promptTokens: 5,
    predictedTokens: 3,
  },
  cacheHitTokens: 0,
  slotId: 0,
  modelId: "test-model",
};

describe("profile matrix", () => {
  it("streams qwen inline reasoning through the full agent loop", async () => {
    await expectScenario({
      props: QWEN3_PROPS,
      chunks: ['inner thought</think>{"tool":"reply","args":{"text":"ok"}}'],
      expectReasoning: true,
    });
  });

  it("streams nemotron inline reasoning through the full agent loop", async () => {
    // Same open/close ownership as qwen: prompt prefills `<think>`, the
    // stream starts mid-body and closes with `</think>` before the array.
    await expectScenario({
      props: NEMOTRON_PROPS,
      chunks: [
        'inner thought</think>[{"tool":"reply","args":{"text":"ok"}}]',
      ],
      expectReasoning: true,
    });
  });

  it("streams gemma 4 channel reasoning through the full agent loop", async () => {
    // Turn-framed gemma: the model emits its OWN `<|channel>thought\n` opener
    // (the prompt no longer prefills it), reasons, then closes with
    // `<channel|>` before the tool-call array.
    await expectScenario({
      props: GEMMA4_PROPS,
      chunks: [
        '<|channel>thought\ninner thought<channel|>{"tool":"reply","args":{"text":"ok"}}',
      ],
      expectReasoning: true,
    });
  });

  it("keeps plain profiles free of reasoning emissions", async () => {
    await expectScenario({
      props: LLAMA3_PROPS,
      chunks: ['{"tool":"reply","args":{"text":"ok"}}'],
      expectReasoning: false,
    });
    await expectScenario({
      props: GPT_OSS_PROPS,
      chunks: ['{"tool":"reply","args":{"text":"ok"}}'],
      expectReasoning: false,
    });
  });
});

async function expectScenario(input: {
  props: Record<string, unknown>;
  chunks: string[];
  expectReasoning: boolean;
}) {
  const llmEvents: AgentLoopEvent[] = [];
  const logs: LogRecord[] = [];
  const harness = await startTestHarness({
    llamaProps: input.props,
    llamaCompleteStream: createStream(input.chunks),
    onAgentEvent: (event) => llmEvents.push(event),
    logSinks: [(record) => logs.push(record)],
  });

  try {
    const result = await harness.runtime.runTurn(harness.runtime.createSession(), "hi", {
      maxSteps: 3,
    });
    expect(result.reason).toBe("reply");

    const reasoningEvents = llmEvents
      .filter(
        (event): event is Extract<AgentLoopEvent, { type: "llm_event" }> =>
          event.type === "llm_event",
      )
      .map((event) => event.event as StepEvent);
    const reasoningText = reasoningEvents
      .filter((event): event is { type: "reasoning"; text: string } => event.type === "reasoning")
      .map((event) => event.text)
      .join("");

    if (input.expectReasoning) {
      expect(reasoningText.length).toBeGreaterThan(0);
    } else {
      expect(reasoningText).toBe("");
    }

    const invariantWarnings = logs.filter(
      (record) =>
        record.level === "warn" &&
        (record.message === "profile/grammar invariant violated" ||
          record.message === "profile/prompt invariant violated"),
    );
    expect(invariantWarnings).toHaveLength(0);
  } finally {
    await harness.cleanup();
  }
}

function createStream(chunks: string[]) {
  return async function* () {
    for (const chunk of chunks) {
      yield {
        delta: chunk,
        reasoningDelta: "",
        done: false,
      };
    }
    return FINAL_COMPLETION;
  };
}
