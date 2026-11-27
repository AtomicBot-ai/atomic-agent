import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopDependencies, AgentLoopEvent } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { LOOP_FINAL_STEP_NOTICE } from "./progress/loop-final-step.js";

/**
 * ATO-2004 (issue #828): when the loop breaker trips, the model gets one
 * terminal-only step to summarize what the turn gathered; the canned stop
 * reply is only the fallback. The scenario is the wandering fan-out of
 * `agent-loop.test.ts`: with the default escalation of 12, eleven distinct
 * fetches run and the twelfth trips the breaker, so completion 13 is the
 * summary step.
 */

const BREAKER_CALL = 12;

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const fetchCall = (n: number) =>
  JSON.stringify([
    { tool: "os.web.fetch", args: { url: `https://example.com/file-${n}.ts` } },
  ]);
const replyCall = (text: string) =>
  JSON.stringify([{ tool: "reply", args: { text } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SUMMARY =
  "The eleven files I read define the fetch helpers; the twelfth was not read.";

describe("AgentLoop loop breaker summary step (ATO-2004)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-breaker-summary-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function setup(
    afterBreaker: (call: number) => string | Error,
    priceCompletion?: AgentLoopDependencies["priceCompletion"],
  ) {
    const prompts: string[] = [];
    const events: AgentLoopEvent[] = [];
    let fetchRuns = 0;
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.web.fetch",
      description: "fetch",
      readonly: true,
      async run(args) {
        fetchRuns += 1;
        const url = (args as { url?: string }).url ?? "";
        return {
          tool: "os.web.fetch",
          status: "ok",
          summary: `content of ${url}`,
          details: {},
          truncated: false,
        };
      },
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        prompts.push(params.prompt);
        const call = prompts.length;
        if (call <= BREAKER_CALL) return completion(fetchCall(call));
        const next = afterBreaker(call);
        if (next instanceof Error) throw next;
        return completion(next);
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      onEvent: (event) => events.push(event),
      ...(priceCompletion ? { priceCompletion } : {}),
    });
    const run = (extra: { taskMaxCostUsd?: number } = {}) =>
      agent.runTurn(createEmptySessionState({ id: "s-breaker-summary", workingDir }), {
        userMessage: "read these files",
        maxSteps: 20,
        signal: new AbortController().signal,
        ...extra,
      });
    return { run, prompts, events, fetchRuns: () => fetchRuns };
  }

  const breakerEvents = (events: AgentLoopEvent[]) =>
    events.filter(
      (e): e is Extract<AgentLoopEvent, { type: "loop_detected" }> =>
        e.type === "loop_detected" && e.level === "breaker",
    );
  const failed = (events: AgentLoopEvent[]) =>
    events.filter((e) => e.type === "loop_failed");

  it("asks the model for one terminal-only summary and makes it the turn's reply", async () => {
    const { run, prompts, events, fetchRuns } = setup(() => replyCall(SUMMARY));
    const result = await run();

    // One more completion after the breaker step, carrying the notice.
    expect(prompts).toHaveLength(BREAKER_CALL + 1);
    expect(prompts[BREAKER_CALL]).toContain(LOOP_FINAL_STEP_NOTICE);
    expect(prompts.slice(0, BREAKER_CALL).join("\n")).not.toContain(
      LOOP_FINAL_STEP_NOTICE,
    );
    expect(fetchRuns()).toBe(BREAKER_CALL - 1);
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBeUndefined();
    expect(failed(events)).toHaveLength(0);
    const last = result.session.turns.at(-1) as { kind: string; text: string };
    expect(last.kind).toBe("assistant_reply");
    expect(last.text).toBe(SUMMARY);
    expect(last.text.startsWith("(stopped: ")).toBe(false);
    // The canned stop reply is not sent alongside the summary.
    const replies = result.session.turns.filter(
      (t) => t.kind === "assistant_reply",
    ) as Array<{ text: string }>;
    expect(replies.some((t) => t.text.startsWith("(stopped: "))).toBe(false);
    // The breaker event itself is unchanged.
    expect(breakerEvents(events)).toHaveLength(1);
    expect(breakerEvents(events)[0]).toMatchObject({
      level: "breaker",
      detector: "wandering",
      count: 12,
      failure: { cause: "loop_detected", action: "switch-model" },
    });
  });

  it("falls back to the canned stop reply when the summary step fails", async () => {
    const { run, prompts, events } = setup(
      () => new Error("summary request failed"),
    );
    const result = await run();

    expect(prompts).toHaveLength(BREAKER_CALL + 1);
    expect(result.reason).toBe("reply");
    expect(failed(events)).toHaveLength(0);
    const last = result.session.turns.at(-1) as { kind: string; text: string };
    expect(last.kind).toBe("assistant_reply");
    expect(last.text).toContain("hit the limit on different arguments");
    expect(last.text).toContain("12, counting the last call");
  });

  it("falls back to the canned stop reply when the summary step calls a tool again", async () => {
    const { run, prompts, events, fetchRuns } = setup((call) => fetchCall(call));
    const result = await run();

    // The summary step's fetch is refused at dispatch, never run, and
    // no further step is taken.
    expect(prompts).toHaveLength(BREAKER_CALL + 1);
    expect(fetchRuns()).toBe(BREAKER_CALL - 1);
    expect(result.reason).toBe("reply");
    expect(failed(events)).toHaveLength(0);
    const last = result.session.turns.at(-1) as { kind: string; text: string };
    expect(last.kind).toBe("assistant_reply");
    expect(last.text).toContain("hit the limit on different arguments");
  });

  it("makes no extra model call when the spend budget is used up", async () => {
    // Free until the breaker step, which spends the whole $1.00 cap: the
    // budget plan for the next step is "stop".
    let priced = 0;
    const price: AgentLoopDependencies["priceCompletion"] = () => {
      priced += 1;
      return priced >= BREAKER_CALL ? 5 : 0;
    };
    const { run, prompts, events } = setup(() => replyCall(SUMMARY), price);
    const result = await run({ taskMaxCostUsd: 1 });

    expect(prompts).toHaveLength(BREAKER_CALL);
    expect(result.reason).toBe("reply");
    expect(failed(events)).toHaveLength(0);
    const last = result.session.turns.at(-1) as { kind: string; text: string };
    expect(last.kind).toBe("assistant_reply");
    expect(last.text).toContain("hit the limit on different arguments");
    expect(breakerEvents(events)).toHaveLength(1);
  });
});
