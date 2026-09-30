import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../tui-state.js";
import { FinalisedMessage } from "./chat-finalised-message.js";
import {
  PENDING_STEER_LABEL_SUFFIX,
  STEERED_LABEL_SUFFIX,
  UserBubble,
} from "./user-bubble.js";

function frame(element: Parameters<typeof render>[0]): string {
  const { lastFrame, unmount } = render(element);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "user", text: "Test", timestamp: 1, ...overrides };
}

describe("UserBubble", () => {
  it("labels a prompt that opened a turn plainly", () => {
    const out = frame(<UserBubble text="Test" />);
    expect(out).toContain("YOU");
    expect(out).not.toContain(STEERED_LABEL_SUFFIX.trim());
  });

  it("says a steered message joined the turn already running", () => {
    const out = frame(<UserBubble text="Test" steered />);
    expect(out).toContain(`YOU${STEERED_LABEL_SUFFIX}`);
  });

  it("says when a steer that is still on its way in will be read", () => {
    // Drawn from the moment Enter is pressed, before any step boundary:
    // the label has to answer "did that send?" on its own.
    const out = frame(<UserBubble text="Test" pending />);
    expect(out).toContain(`YOU${PENDING_STEER_LABEL_SUFFIX}`);
    // Not past tense — the turn has not read it yet.
    expect(out).not.toContain(STEERED_LABEL_SUFFIX.trim());
  });

  it("gets the mark from the transcript message", () => {
    const steered = frame(
      <FinalisedMessage
        message={userMessage({ steered: true })}
        toolsExpandedById={{}}
        planHandoff={null}
      />,
    );
    expect(steered).toContain(`YOU${STEERED_LABEL_SUFFIX}`);
    const plain = frame(
      <FinalisedMessage
        message={userMessage()}
        toolsExpandedById={{}}
        planHandoff={null}
      />,
    );
    expect(plain).not.toContain(STEERED_LABEL_SUFFIX.trim());
  });

  it("offers [try again] on the opening request but not on a steer", () => {
    // Re-sent alone, a steer opens a new turn on the correction without
    // the request it corrected: the confusion the label is there to end.
    const steered = frame(
      <FinalisedMessage
        message={userMessage({ steered: true })}
        toolsExpandedById={{}}
        planHandoff={null}
      />,
    );
    expect(steered).toContain("[copy]");
    expect(steered).not.toContain("[try again]");
    const plain = frame(
      <FinalisedMessage
        message={userMessage()}
        toolsExpandedById={{}}
        planHandoff={null}
      />,
    );
    expect(plain).toContain("[try again]");
  });
});
