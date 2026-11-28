import { describe, expect, it } from "vitest";

import {
  assistantToolCallTurn,
  packConversation,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../session/conversation-turn.js";
import { renderPackedConversation } from "./build-prompt-world-conversation.js";
import { packConversationToFit } from "./fit-pinned-conversation.js";
import { estimateTokens } from "./token-budget.js";

/**
 * ATO-1678: the current task is pinned whole (its request and every
 * call after it), so a long task rendered far past the transcript cap:
 * 10.5k tokens against a 512 cap on the Sentry event. On a known window
 * the pack now shrinks the pinned result bodies until it fits.
 */

/** One request and `calls` HTTP calls, each with a ~900-token body. */
function longTask(calls: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [userTurn("collect the data from every page", 1)];
  for (let i = 0; i < calls; i += 1) {
    turns.push(
      assistantToolCallTurn({
        tool: "os.http.request",
        args: { url: `https://example.com/page/${i}`, method: "GET" },
        at: 2 + i * 2,
      }),
      toolResultTurn({
        tool: "os.http.request",
        status: "ok",
        summary: `page ${i} `.concat("word ".repeat(640)),
        at: 3 + i * 2,
      }),
    );
  }
  return turns;
}

const cost = (packed: Parameters<typeof renderPackedConversation>[0]) =>
  estimateTokens(renderPackedConversation(packed));

describe("packConversationToFit (ATO-1678)", () => {
  const CAP = 4000;

  it("brings a pinned task that overflows the cap under it", () => {
    const turns = longTask(10);
    // The packer alone keeps the whole pinned task past the cap.
    const plain = packConversation(turns, CAP, {});
    expect(cost(plain)).toBeGreaterThan(CAP);
    const fitted = packConversationToFit(turns, CAP, {}, true);
    expect(cost(fitted)).toBeLessThanOrEqual(CAP);
  });

  it("keeps the request and every call in view; only result bodies shrink", () => {
    const turns = longTask(10);
    const fitted = packConversationToFit(turns, CAP, {}, true);
    expect(fitted.visibleTurns.map((t) => t.kind)).toEqual(turns.map((t) => t.kind));
    expect(fitted.visibleTurns[0]).toBe(turns[0]);
    const result = fitted.visibleTurns[2];
    expect(result?.kind === "tool_result" && result.summary).toMatch(
      /more chars of this result are not shown/,
    );
  });

  it("leaves a transcript that fits untouched", () => {
    const turns = longTask(2);
    const fitted = packConversationToFit(turns, 100_000, {}, true);
    expect(fitted.visibleTurns).toEqual(turns);
    expect(fitted.visibleTurns[2]).toBe(turns[2]);
  });

  it("packs as before when no window is known", () => {
    const turns = longTask(10);
    const plain = packConversation(turns, CAP, {});
    const unknown = packConversationToFit(turns, CAP, {}, false);
    expect(cost(unknown)).toBe(cost(plain));
  });
});
