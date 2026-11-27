import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { formatPathRuleAttached } from "./format-event.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

const session: TuiSessionInfo = {
  sessionId: null,
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

/** ATO-2443: a path rule that joined the prompt is one line in the chat. */
describe("path_rule_attached in the TUI", () => {
  it("adds a system line naming the rule file", () => {
    const state = reduceTuiState(createInitialTuiState(session), {
      type: "agent_event",
      event: {
        type: "llm_event",
        event: { type: "path_rule_attached", path: ".atomic-agent/rules/sql.md", patterns: ["*.sql"], stepIndex: 2 },
      },
    } as never);
    const last = state.messages.at(-1);
    expect(last).toMatchObject({ role: "system", text: "rule attached: .atomic-agent/rules/sql.md" });
  });

  it("words the line the same for a global rule", () => {
    expect(formatPathRuleAttached("~/.atomic-agent/rules/css.md")).toBe("rule attached: ~/.atomic-agent/rules/css.md");
  });
});
