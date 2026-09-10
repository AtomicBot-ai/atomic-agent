import { stat } from "node:fs/promises";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Upper bound on files one reply may carry. A remote-control chat is
 * not a file sync; a model that wants to ship a directory should zip
 * it. Telegram and Discord both post files one message each, so the
 * cap also bounds how many messages a single reply can fan out into.
 */
export const REPLY_ATTACHMENTS_MAX = 10;

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
    "Send a natural-language reply to the user. Ends this turn; the session stays open. Optional `attachments`: paths of existing files to deliver with the reply.",
  readonly: true,
  async run(rawArgs, ctx) {
    const text = coerceReplyText(rawArgs.text);
    if (text === null) {
      throw new Error("reply: `text` must be a non-empty string");
    }
    const attachments = await resolveReplyAttachments(
      rawArgs.attachments,
      ctx.workingDir,
    );
    return compressToolResult({
      tool: "reply",
      status: "ok",
      output: text,
      details: {
        text,
        terminal: "turn",
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });
  },
};

/**
 * Validate and resolve `reply.attachments` to absolute paths.
 *
 * Errors are thrown, not folded into the result, on purpose: `reply`
 * is the turn terminal, and a reply that names a file which does not
 * exist must not end the turn with a silent partial delivery. The
 * thrown message reaches the model as an ordinary tool error, so it
 * can fix the path (or drop the attachment) and reply again. The
 * ordinary checks are cheap — one `stat` per path — and a directory
 * is rejected because no channel can post one.
 *
 * Accepted shapes: `string[]` (canonical), a single `string` (small
 * models flatten one-element arrays), `undefined` / `null` / `[]`
 * (no attachments). Anything else is a model mistake and errors.
 */
export async function resolveReplyAttachments(
  raw: unknown,
  workingDir: string,
): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return [];
  if (list.length > REPLY_ATTACHMENTS_MAX) {
    throw new Error(
      `reply: at most ${REPLY_ATTACHMENTS_MAX} attachments per reply (got ${list.length})`,
    );
  }
  const resolved: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        "reply: `attachments` must be an array of non-empty file paths",
      );
    }
    const absolute = resolveUserPath(entry.trim(), workingDir);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new Error(`reply: attachment not found: ${absolute}`);
    }
    if (!info.isFile()) {
      throw new Error(`reply: attachment is not a file: ${absolute}`);
    }
    if (!resolved.includes(absolute)) resolved.push(absolute);
  }
  return resolved;
}

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
