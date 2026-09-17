import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../tui-state.js";
import { FinalisedMessage } from "./chat-finalised-message.js";
import { STEERED_LABEL_SUFFIX, UserBubble } from "./user-bubble.js";

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
});
