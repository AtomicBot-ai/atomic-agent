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
    const text = coerceReplyText(rawArgs.text);
    if (text === null) {
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

/**
 * Defensive coercion for `reply.text`. The descriptor and grammar
 * advertise `text: string`, but small models (qwen-3.5-9b in
 * particular) interpret prompts like "reply with just the integer"
 * literally and emit a JSON number. Without this coercion the run
 * dies on `reply:error` after a successful tool chain — exactly the
 * pattern surfaced by `axis-min-steps-single-read` and
 * `axis-context-retention-config-value` in the diagnostic eval suite.
 *
 * Accepted: non-empty string (verbatim), finite number (toString),
 * boolean (toString). Anything else (null, undefined, object, array,
 * empty string) returns null so the caller raises the original error
 * — those cases are real model mistakes, not under-spec values.
 */
function coerceReplyText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return null;
}
