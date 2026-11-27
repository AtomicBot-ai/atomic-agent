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

/**
 * How the step reads reasoning in this completion's raw text. A think
 * prefill profile on grammar (qwen-think, `requiresPromptThinkPrefix`)
 * carries the opening tag in the PROMPT, so the completion starts mid
 * thought with no opening tag at all (`completionAssumesOpenReasoning`):
 * text with no closing tag is then all reasoning. Tags are the profile's
 * own (Gemma 4: `<|channel>thought` / `<channel|>`); the defaults are
 * `<think>` / `</think>`.
 */
export interface CutReading {
  openReasoning?: boolean;
  openTag?: string;
  closeTag?: string;
}

export function locateCut(
  completion: Pick<CompletionResult, "content" | "reasoningContent" | "toolCalls">,
  reading: CutReading = {},
): CutLocation | null {
  const calls = completion.toolCalls ?? [];
  if (calls.length > 0) {
    return withTool("tool_call", calls[calls.length - 1]?.function.name);
  }
  const open = nonEmpty(reading.openTag) ?? THINK_OPEN;
  const close = nonEmpty(reading.closeTag) ?? THINK_CLOSE;
  const content = typeof completion.content === "string" ? completion.content : "";
  const reasoning =
    typeof completion.reasoningContent === "string" ? completion.reasoningContent.trim() : "";
  const closeAt = content.lastIndexOf(close);
  // An opened think block that never closed: the cut came mid-thought.
  if (closeAt < 0 && content.includes(open)) return { part: "reasoning" };
  // The prompt opened the block and nothing closed it. Unless the server
  // split the think block into its own channel, in which case `content`
  // is the body and is read as such below.
  if (closeAt < 0 && reading.openReasoning === true && reasoning.length === 0) {
    return content.trim().length > 0 ? { part: "reasoning" } : null;
  }
  const body = (closeAt >= 0 ? content.slice(closeAt + close.length) : content).trim();
  if (body.length === 0) {
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

function nonEmpty(tag: string | undefined): string | undefined {
  return tag !== undefined && tag.trim().length > 0 ? tag.trim() : undefined;
}
