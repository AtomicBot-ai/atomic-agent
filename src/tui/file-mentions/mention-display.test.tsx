import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { estimateMessageHeight } from "../chat/chat-message-height.js";
import { UserBubble } from "../chat/user-bubble.js";
import { appendUserMessage } from "../reducer-helpers.js";
import { createInitialTuiState, type ChatMessage, type TuiSessionInfo } from "../tui-state.js";
import { appendMentionBlock } from "./mention-block.js";

const session: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  completionMaxTokens: 2048,
  skillCount: 0,
  localBackendConfigured: false,
};

const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
const sent = appendMentionBlock("explain @src/app.ts", [
  { path: "src/app.ts", bytes: content.length, content },
]);

describe("a message with @-mentioned files in the chat", () => {
  it("draws the typed text and one line per file, not the file body", () => {
    const { lastFrame, unmount } = render(<UserBubble text={sent} />);
    const out = lastFrame() ?? "";
    unmount();
    expect(out).toContain("explain @src/app.ts");
    expect(out).toContain("+ src/app.ts");
    expect(out).not.toContain("line 39");
  });

  it("measures the folded bubble, not the whole message", () => {
    const message: ChatMessage = { id: "m1", role: "user", text: sent, timestamp: 1 };
    const plain: ChatMessage = { ...message, text: "explain @src/app.ts\n  + src/app.ts (2 B)" };
    expect(estimateMessageHeight(message)).toBe(estimateMessageHeight(plain));
  });

  it("keeps the full message in the transcript and only the typed text in history", () => {
    const next = appendUserMessage(createInitialTuiState(session), sent);
    expect(next.messages.at(-1)?.text).toBe(sent);
    expect(next.inputHistory.at(-1)).toBe("explain @src/app.ts");
  });
});
