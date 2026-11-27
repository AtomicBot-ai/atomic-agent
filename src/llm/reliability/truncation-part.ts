import type { CompletionResult } from "../llama-server-client.js";
import type { TruncationPart } from "./failure-category.js";

/**
 * Where a reply was when the server cut it at its length limit
 * (ATO-1678).
 *
 * A cut reply is three stories with three ways out, and the retry used
 * to tell the model the same thing for all of them:
 *
 *  - `reasoning`: the cut came inside the think block, before any tool
 *    call or answer began. The way out is to think less;
 *  - `tool_call`: a tool call had started and its arguments were cut, so
 *    the call never ran. The way out is the same work in smaller pieces
 *    (a large file written in parts), as Claude Code tells a model whose
 *    tool call ran into `max_tokens`;
 *  - `text`: an answer or plain prose was cut (the in-step continuation
 *    handles a cut `reply`).
 *
 * `null` when nothing came back to read. `tool` is the name of the call
 * that was cut, only when it is a bounded identifier: it goes into the
 * retry's notice to the model on this machine, never into a report.
 */
export interface CutLocation {
  part: TruncationPart;
  tool?: string;
}

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A grammar call opens with its tool name: `{"tool": "os.fs.write", "args": ...}`. */
const GRAMMAR_CALL_RE = /"tool"\s*:\s*"([^"\\]{1,64})"/g;
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export function locateCut(
  completion: Pick<CompletionResult, "content" | "reasoningContent" | "toolCalls">,
): CutLocation | null {
  const calls = completion.toolCalls ?? [];
  if (calls.length > 0) {
    return withTool("tool_call", calls[calls.length - 1]?.function.name);
  }
  const content = typeof completion.content === "string" ? completion.content : "";
  const closeAt = content.lastIndexOf(THINK_CLOSE);
  // An opened think block that never closed: the cut came mid-thought.
  if (closeAt < 0 && content.includes(THINK_OPEN)) return { part: "reasoning" };
  const body = (closeAt >= 0 ? content.slice(closeAt + THINK_CLOSE.length) : content).trim();
  if (body.length === 0) {
    const reasoning =
      typeof completion.reasoningContent === "string" ? completion.reasoningContent.trim() : "";
    return reasoning.length > 0 ? { part: "reasoning" } : null;
  }
  if (body.startsWith("[") || body.startsWith("{")) {
    // The last call opened is the one the cut landed in.
    let name: string | undefined;
    for (const match of body.matchAll(GRAMMAR_CALL_RE)) name = match[1];
    // A grammar `reply` whose text was cut is an answer, not a tool call.
    if (name === "reply") return { part: "text" };
    return withTool("tool_call", name);
  }
  return { part: "text" };
}

function withTool(part: TruncationPart, name: string | undefined): CutLocation {
  if (part === "tool_call" && name === "reply") return { part: "text" };
  return name !== undefined && TOOL_NAME_RE.test(name) ? { part, tool: name } : { part };
}
