import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentLoopEvent } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import {
  assistantReplyTurn,
  isStoppedTurnMarker,
  STOPPED_TURN_MARKER_TEXT,
  userTurn,
} from "../session/conversation-turn.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * ATO-233. A turn the user stopped used to leave only its `user` row, so
 * the next message landed straight after it and the model read the two
 * as one request: "write a 1000-word story about a dog", Stop, "how are
 * you?" — and the model wrote the story. A stopped turn now ends on a
 * stop marker the next turn's prompt shows, and only a stop leaves one.
 */

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
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

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 1,
      predictedMs: 1,
      promptTokens: 10,
      predictedTokens: 5,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const STORY = "Write a detailed 1000-word story about a dog";

describe("a turn the user stopped", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-stop-marker-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loopWith(
    llmComplete: (params: { prompt: string }) => Promise<CompletionResult>,
    events: AgentLoopEvent[] = [],
  ): AgentLoop {
    return new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      onEvent: (event) => events.push(event),
    });
  }

  /** Run `STORY` and stop it while its request is in flight. */
  async function stoppedMidRequest(
    events: AgentLoopEvent[] = [],
  ): Promise<SessionState> {
    const controller = new AbortController();
    const loop = loopWith(async () => {
      controller.abort();
      throw new TransportError("terminated", null, "");
    }, events);
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-stop", workingDir }),
      {
        userMessage: STORY,
        maxSteps: 5,
        taskMaxSteps: 5,
        providerWaitEnabled: false,
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    return result.session;
  }

  it("ends on a stop marker after the stopped request", async () => {
    const events: AgentLoopEvent[] = [];
    const session = await stoppedMidRequest(events);
    expect(session.status).toBe("cancelled");
    expect(session.turnCount).toBe(1);
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toMatchObject({ kind: "user", text: STORY });
    expect(isStoppedTurnMarker(session.turns[1])).toBe(true);
    expect(session.turns[1]).toMatchObject({ text: STOPPED_TURN_MARKER_TEXT });
    // Recorded for the model only: no surface is handed it as a reply.
    expect(
      events.some(
        (event) =>
          event.type === "llm_event" && event.event.type === "assistant_reply",
      ),
    ).toBe(false);
  });

  it("ends on a stop marker when stopped before its first step", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const loop = loopWith(async () => {
      calls += 1;
      return makeCompletion(
        JSON.stringify({ tool: "reply", args: { text: "never" } }),
      );
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-stop-early", workingDir }),
      { userMessage: STORY, maxSteps: 5, signal: controller.signal },
    );
    expect(calls).toBe(0);
    expect(result.reason).toBe("cancelled");
    expect(result.session.turns.map((t) => t.kind)).toEqual([
      "user",
      "assistant_reply",
    ]);
    expect(isStoppedTurnMarker(result.session.turns[1])).toBe(true);
  });

  it("shows the next turn the stopped request as closed, before the new message", async () => {
    const stopped = await stoppedMidRequest();
    const prompts: string[] = [];
    const loop = loopWith(async (params) => {
      prompts.push(params.prompt);
      return makeCompletion(
        JSON.stringify({ tool: "reply", args: { text: "Fine, thanks!" } }),
      );
    });
    const result = await loop.runTurn(stopped, {
      userMessage: "how are you?",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    const prompt = prompts[0] ?? "";
    const asked = prompt.indexOf(`user: ${STORY}`);
    const marker = prompt.indexOf(`assistant: ${STOPPED_TURN_MARKER_TEXT}`);
    const next = prompt.indexOf("user: how are you?");
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(asked);
    expect(next).toBeGreaterThan(marker);
    // The answered turn ends on its own reply, after the marker.
    const kinds = result.session.turns.map((t) =>
      isStoppedTurnMarker(t) ? "stopped" : t.kind,
    );
    expect(kinds).toEqual(["user", "stopped", "user", "assistant_reply"]);
  });

  it("is not left by a turn that failed", async () => {
    const loop = loopWith(async () => {
      throw new TransportError("terminated", null, "");
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-failed", workingDir }),
      {
        userMessage: STORY,
        maxSteps: 5,
        taskMaxSteps: 5,
        providerWaitEnabled: false,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(result.session.turns.some(isStoppedTurnMarker)).toBe(false);
    const last = result.session.turns[result.session.turns.length - 1];
    expect((last as { text: string }).text).toContain("this turn failed");
  });

  it("is not left by an ephemeral (fusion worker) turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const loop = loopWith(async () =>
      makeCompletion(JSON.stringify({ tool: "reply", args: { text: "x" } })),
    );
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-worker", workingDir }),
      {
        userMessage: "worker brief",
        maxSteps: 5,
        ephemeral: true,
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    expect(result.session.turns.some(isStoppedTurnMarker)).toBe(false);
  });

  it("is not left when the stopped turn had no request of its own", async () => {
    // A turn started without a message (a task runner resuming) and
    // stopped before it recorded anything: the transcript still ends on
    // the previous turn's answer, and there is nothing to mark.
    const controller = new AbortController();
    controller.abort();
    const loop = loopWith(async () =>
      makeCompletion(JSON.stringify({ tool: "reply", args: { text: "x" } })),
    );
    const answered: SessionState = {
      ...createEmptySessionState({ id: "s-no-message", workingDir }),
      turns: [userTurn("hello", 1), assistantReplyTurn("hi there", 2)],
    };
    const result = await loop.runTurn(answered, {
      maxSteps: 5,
      signal: controller.signal,
    });
    expect(result.reason).toBe("cancelled");
    expect(result.session.turns).toHaveLength(2);
    expect(result.session.turns.some(isStoppedTurnMarker)).toBe(false);
  });
});
