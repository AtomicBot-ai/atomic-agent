import { describe, expect, it, vi } from "vitest";

import type { ApprovalDecision, ApprovalRequest } from "../../approval/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import { ApprovalBridge } from "./approval-bridge.js";

/** ATO-489: an `ask_user` question in a Telegram chat. */
function setup(): {
  bridge: ApprovalBridge;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  decisions: ApprovalDecision[];
} {
  const decisions: ApprovalDecision[] = [];
  const sendMessage = vi.fn(async () => ({ message_id: 7 }));
  const editMessageText = vi.fn(async () => undefined);
  const bridge = new ApprovalBridge({
    api: { sendMessage, editMessageText, answerCallbackQuery: vi.fn(async () => undefined) },
    approvals: {
      resolve: (decision) => {
        decisions.push(decision);
        return true;
      },
    },
    ownerUserId: 42,
    logger: new StructuredLogger({ level: "warn", sinks: [] }),
    schedule: () => () => {},
  });
  return { bridge, sendMessage, editMessageText, decisions };
}

const QUESTION_REQUEST: ApprovalRequest = {
  approvalId: "q-1",
  sessionId: "s-1",
  tool: "ask_user",
  category: "user_question",
  reason: "Which database?",
  question: {
    prompt: "Which database?",
    options: [{ label: "SQLite", description: "one file" }, { label: "Postgres" }],
    multiSelect: false,
    allowOther: true,
  },
};

const click = (data: string) => ({ id: "cb", from: { id: 42 }, data });

describe("Telegram question buttons (ATO-489)", () => {
  it("sends the question with one button per option and a Skip, no Approve", async () => {
    const { bridge, sendMessage } = setup();
    await bridge.dispatch(QUESTION_REQUEST, 1);
    const [, text, options] = sendMessage.mock.calls[0] as unknown as [
      number,
      string,
      { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } },
    ];
    expect(text).toBe("Question from the agent\nWhich database?\n\n1. SQLite - one file\n2. Postgres");
    expect(options.reply_markup.inline_keyboard).toEqual([
      [{ text: "SQLite", callback_data: "appr:q-1:o0" }],
      [{ text: "Postgres", callback_data: "appr:q-1:o1" }],
      [{ text: "Skip", callback_data: "appr:q-1:n" }],
    ]);
  });

  it("answers with the option pressed", async () => {
    const { bridge, decisions, editMessageText } = setup();
    await bridge.dispatch(QUESTION_REQUEST, 1);
    await bridge.handleCallback(click("appr:q-1:o1"));
    expect(decisions).toEqual([
      { approvalId: "q-1", approved: true, answer: { selected: ["Postgres"] } },
    ]);
    expect((editMessageText.mock.calls[0] as unknown[] | undefined)?.[2]).toContain("Postgres");
  });

  it("skips on Skip and ignores an Approve the message never offered", async () => {
    const { bridge, decisions } = setup();
    await bridge.dispatch(QUESTION_REQUEST, 1);
    await bridge.handleCallback(click("appr:q-1:y"));
    expect(decisions).toEqual([]);
    await bridge.handleCallback(click("appr:q-1:n"));
    expect(decisions).toEqual([{ approvalId: "q-1", approved: false }]);
  });

  it("drops an option index the question does not have, and options on an approval", async () => {
    const { bridge, decisions } = setup();
    await bridge.dispatch(QUESTION_REQUEST, 1);
    await bridge.handleCallback(click("appr:q-1:o5"));
    expect(decisions).toEqual([]);
    await bridge.dispatch(
      { approvalId: "a-1", sessionId: "s-1", tool: "os.shell.run", category: "shell", reason: "run" },
      1,
    );
    await bridge.handleCallback(click("appr:a-1:o0"));
    expect(decisions).toEqual([]);
  });
});
