import { describe, expect, it } from "vitest";

import {
  INTERRUPTED_TURN_RESUME_NOTE,
  interruptedChatTurn,
  interruptedTurnResumeMessage,
} from "./interrupted-chat-turn.js";
import { INTERRUPTED_TURN_ENDING } from "./session-store.js";
import type { TurnProgress } from "./turn-progress.js";

/** A chat turn a restart cut off is offered, never continued on its own (ATO-448). */

function marker(extra: Partial<TurnProgress> = {}): TurnProgress {
  return {
    stepsDone: 2,
    lastStepIndex: 1,
    request: "deploy the site and tell the team",
    options: { interactive: true },
    resumes: 0,
    startedAt: 1_000,
    updatedAt: 2_000,
    ...extra,
  };
}

const interrupted = {
  status: INTERRUPTED_TURN_ENDING.status,
  lastError: INTERRUPTED_TURN_ENDING.lastError ?? null,
};

describe("interruptedChatTurn", () => {
  it("offers the last turn when a restart cut it off and its marker is still there", () => {
    expect(interruptedChatTurn(interrupted, marker())).toEqual({
      request: "deploy the site and tell the team",
      stepsDone: 2,
      startedAt: 1_000,
    });
  });

  it("offers nothing when the last turn was not interrupted by a restart", () => {
    // Ended on its own: the marker is gone.
    expect(interruptedChatTurn(interrupted, null)).toBeNull();
    // A person stopped it: cancelled, but without the restart's sentence.
    expect(
      interruptedChatTurn({ status: "cancelled", lastError: null }, marker()),
    ).toBeNull();
    // It failed.
    expect(
      interruptedChatTurn({ status: "failed", lastError: "boom" }, marker()),
    ).toBeNull();
    // It is running again (another window started a turn).
    expect(
      interruptedChatTurn({ status: "running", lastError: null }, marker()),
    ).toBeNull();
  });

  it("leaves a durable task's turn to the task runner", () => {
    expect(
      interruptedChatTurn(interrupted, marker({ options: { taskId: "t-1" } })),
    ).toBeNull();
  });

  it("offers nothing for a blank request", () => {
    expect(interruptedChatTurn(interrupted, marker({ request: "  " }))).toBeNull();
  });
});

describe("interruptedTurnResumeMessage", () => {
  it("starts with the note about side effects, then repeats the request", () => {
    const turn = interruptedChatTurn(interrupted, marker());
    const message = interruptedTurnResumeMessage(turn!);
    expect(message.startsWith(`[Resumed] ${INTERRUPTED_TURN_RESUME_NOTE}`)).toBe(true);
    expect(INTERRUPTED_TURN_RESUME_NOTE).toContain("cut off by a restart");
    expect(INTERRUPTED_TURN_RESUME_NOTE).toContain(
      "check the current state before repeating any action with side effects (shell commands, file writes, messages, git push)",
    );
    expect(message).toContain("It had completed 2 steps");
    expect(message.endsWith("The interrupted request:\ndeploy the site and tell the team")).toBe(true);
  });

  it("does not mention steps when none was completed", () => {
    const turn = interruptedChatTurn(interrupted, marker({ stepsDone: 0 }));
    expect(interruptedTurnResumeMessage(turn!)).not.toContain("It had completed");
  });

  it("does not stack notes when a resumed turn is cut off again", () => {
    const first = interruptedTurnResumeMessage(interruptedChatTurn(interrupted, marker())!);
    // The continuing turn recorded its whole message as the request.
    const again = interruptedChatTurn(interrupted, marker({ request: first, stepsDone: 1 }));
    expect(again?.request).toBe("deploy the site and tell the team");
    const message = interruptedTurnResumeMessage(again!);
    expect(message.match(/\[Resumed\]/g)).toHaveLength(1);
  });
});
