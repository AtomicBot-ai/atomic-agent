import { describe, expect, it } from "vitest";

import { lastReplyOfTurn } from "./phone-push.js";
import type { ChatMessage } from "./tui-state.js";

const msg = (
  role: ChatMessage["role"],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id: `${role}-${text}`, role, text, ...extra });

describe("lastReplyOfTurn (ATO-1129)", () => {
  it("is the last real answer after the last prompt", () => {
    expect(
      lastReplyOfTurn([
        msg("user", "old question"),
        msg("assistant", "old answer"),
        msg("user", "fix the build"),
        msg("assistant", "working on it", { progressNote: true }),
        msg("system", "tool ran"),
        msg("assistant", "Build fixed."),
      ]),
    ).toBe("Build fixed.");
  });

  it("does not reach back into the previous turn", () => {
    expect(
      lastReplyOfTurn([
        msg("user", "q1"),
        msg("assistant", "a1"),
        msg("user", "q2"),
        msg("system", "Turn failed"),
      ]),
    ).toBeNull();
  });

  it("looks past a steering message folded into the running turn", () => {
    expect(
      lastReplyOfTurn([
        msg("user", "q"),
        msg("assistant", "the answer"),
        msg("user", "also check X", { steered: true }),
      ]),
    ).toBe("the answer");
  });
});
