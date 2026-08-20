import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentLoopEvent } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { SteeringInbox } from "../runtime/steering-inbox.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * Mid-turn steering. Pins:
 *   - A message pushed while the turn is running reaches the NEXT
 *     step's prompt as a `### notice` block — never the step already
 *     in flight, and never a later turn.
 *   - It is also recorded as a real `user` turn, so the transcript
 *     does not lie about what the operator said.
 *   - The loop-detector's own one-shot notice is composed with, not
 *     clobbered by, a steer landing in the same step.
 *   - Nothing is ever silently lost: a message that arrives too late
 *     to be drained comes back on `RunTurnResult.undelivered`, on the
 *     normal path and on the cancelled path alike.
 *   - Without a `steeringInbox` dep the loop behaves exactly as before.
 */

function makeCompletion(content: string): CompletionResult {
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

const TOOLS: ToolDescriptor[] = [
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

const SKILLS: SkillCatalogEntry[] = [];

const NOOP = JSON.stringify({ tool: "noop", args: {} });
const REPLY = JSON.stringify({ tool: "reply", args: { text: "done" } });

interface Harness {
  loop: AgentLoop;
  tails: string[];
  events: AgentLoopEvent[];
}

function buildLoop(opts: {
  inbox?: SteeringInbox;
  onStep?: (stepIndex: number) => void;
  steps?: number;
}): Harness {
  const tails: string[] = [];
  const events: AgentLoopEvent[] = [];
  const totalSteps = opts.steps ?? 2;
  let calls = 0;
  const registry = buildDefaultToolRegistry();
  // A trivial non-terminal tool so the turn takes more than one step —
  // steering only exists between step boundaries, so a one-step turn
  // could not exercise it.
  registry.register({
    name: "noop",
    description: "does nothing",
    readonly: true,
    run: async () => ({
      tool: "noop",
      status: "ok" as const,
      summary: "noop",
      details: {},
      truncated: false,
    }),
  });
  const loop = new AgentLoop({
    registry,
    slotManager: new SlotManager(2),
    grammar: 'root ::= "ok"',
    llmComplete: async () => {
      calls += 1;
      opts.onStep?.(calls - 1);
      return makeCompletion(calls < totalSteps ? NOOP : REPLY);
    },
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: SKILLS,
    ...(opts.inbox ? { steeringInbox: opts.inbox } : {}),
    onEvent: (event) => {
      events.push(event);
      if (event.type === "llm_event" && event.event.type === "prompt_captured") {
        tails.push(event.event.tail);
      }
    },
  });
  return { loop, tails, events };
}

describe("AgentLoop mid-turn steering", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-steer-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("folds a message sent during step 0 into step 1's prompt", async () => {
    const inbox = new SteeringInbox();
    const { loop, tails } = buildLoop({
      inbox,
      // Pushed while step 0's inference is in flight — the realistic
      // shape of "the operator typed while the agent was working".
      onStep: (step) => {
        if (step === 0) inbox.push("s-steer", "actually, check the logs first");
      },
    });
    const session = createEmptySessionState({ id: "s-steer", workingDir });
    await loop.runTurn(session, {
      userMessage: "do the thing",
      maxSteps: 4,
      signal: new AbortController().signal,
    });

    expect(tails).toHaveLength(2);
    // Step 0 was already committed when the message arrived.
    expect(tails[0]).not.toContain("actually, check the logs first");
    expect(tails[1]).toContain("### notice");
    expect(tails[1]).toContain("actually, check the logs first");
  });

  it("does not leak the notice into the step after that", async () => {
    const inbox = new SteeringInbox();
    const { loop, tails } = buildLoop({
      inbox,
      steps: 3,
      onStep: (step) => {
        if (step === 0) inbox.push("s-once", "one-shot please");
      },
    });
    await loop.runTurn(createEmptySessionState({ id: "s-once", workingDir }), {
      userMessage: "go",
      maxSteps: 4,
      signal: new AbortController().signal,
    });
    // The NOTICE is one-shot. The message itself stays visible in
    // `### conversation` forever — it is a real user turn, and that is
    // the point — so assert on the notice framing, not on the text.
    expect(tails[1]).toContain("### notice");
    expect(tails[1]).toMatch(/Take it into account before your next action/);
    expect(tails[2]).not.toMatch(/Take it into account before your next action/);
    expect(tails[2]).toContain("one-shot please");
  });

  it("records the steer as a real user turn and emits steer_applied", async () => {
    const inbox = new SteeringInbox();
    const { loop, events } = buildLoop({
      inbox,
      onStep: (step) => {
        if (step === 0) inbox.push("s-turn", "and use the staging db");
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-turn", workingDir }),
      { userMessage: "deploy", maxSteps: 4, signal: new AbortController().signal },
    );

    const userTurns = result.session.turns.filter((t) => t.kind === "user");
    expect(userTurns.map((t) => (t as { text: string }).text)).toEqual([
      "deploy",
      "and use the staging db",
    ]);
    expect(events).toContainEqual({
      type: "steer_applied",
      text: "and use the staging db",
      stepIndex: 1,
    });
  });

  it("delivers several messages queued between two steps in one notice", async () => {
    const inbox = new SteeringInbox();
    const { loop, tails } = buildLoop({
      inbox,
      onStep: (step) => {
        if (step === 0) {
          inbox.push("s-multi", "first correction");
          inbox.push("s-multi", "second correction");
        }
      },
    });
    await loop.runTurn(createEmptySessionState({ id: "s-multi", workingDir }), {
      userMessage: "go",
      maxSteps: 4,
      signal: new AbortController().signal,
    });
    expect(tails[1]).toContain("first correction");
    expect(tails[1]).toContain("second correction");
    expect(tails[1]).toContain("2 new messages");
  });

  it("hands back a message that arrived too late to be drained", async () => {
    const inbox = new SteeringInbox();
    const { loop } = buildLoop({
      inbox,
      // Pushed during the FINAL inference: the loop terminates on this
      // step's `reply`, so no further step boundary exists to drain it.
      onStep: (step) => {
        if (step === 1) inbox.push("s-late", "too late to steer");
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-late", workingDir }),
      { userMessage: "go", maxSteps: 4, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(result.undelivered).toEqual(["too late to steer"]);
    // And it really is gone from the inbox — it is the caller's now.
    expect(inbox.peek("s-late")).toEqual([]);
  });

  it("hands back pending messages when the turn is cancelled", async () => {
    const inbox = new SteeringInbox();
    const controller = new AbortController();
    const { loop } = buildLoop({
      inbox,
      steps: 5,
      onStep: (step) => {
        if (step === 0) {
          inbox.push("s-cancel", "never delivered");
          controller.abort();
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-cancel", workingDir }),
      { userMessage: "go", maxSteps: 4, signal: controller.signal },
    );
    expect(result.undelivered).toEqual(["never delivered"]);
  });

  it("returns no undelivered messages on an ordinary turn", async () => {
    const { loop } = buildLoop({ inbox: new SteeringInbox() });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-plain", workingDir }),
      { userMessage: "go", maxSteps: 4, signal: new AbortController().signal },
    );
    expect(result.undelivered).toEqual([]);
  });

  it("behaves exactly as before when no inbox is wired in", async () => {
    const { loop, tails } = buildLoop({});
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-none", workingDir }),
      { userMessage: "go", maxSteps: 4, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(result.undelivered).toEqual([]);
    for (const tail of tails) expect(tail).not.toContain("### notice");
  });
});
