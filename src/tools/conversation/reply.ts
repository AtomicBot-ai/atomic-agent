import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Turn-terminal tool. Emitting `reply` closes the current macro-turn and
 * returns a natural-language answer to the user, but keeps the session
 * alive for the next user message. This is the conversational counterpart
 * to `finish` (which closes the whole session).
 *
 * The tool result carries `details.terminal: "turn"` so the agent loop
 * can distinguish it from an ordinary tool call without string-matching
 * on the tool name.
 */
export const replyTool: ToolDefinition = {
  name: "reply",
  description:
    "Send a natural-language reply to the user. Ends this turn; the session stays open.",
  readonly: true,
  async run(rawArgs) {
    const text = rawArgs.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("reply: `text` must be a non-empty string");
    }
    return compressToolResult({
      tool: "reply",
      status: "ok",
      output: text,
      details: { text, terminal: "turn" },
    });
  },
};
