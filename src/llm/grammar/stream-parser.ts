/**
 * Incremental parser for the raw SSE stream emitted by llama-server under
 * our tool-call grammar. Two things are surfaced live to the caller:
 *  - Reasoning-tag blocks (for example `<think>...</think>`) → emitted as
 *    reasoning deltas.
 *  - `{"tool":"reply","args":{"text":"..."}}` → emitted as assistant deltas.
 *
 * The parser is intentionally best-effort: it only recognises the stable
 * tail shapes above and otherwise stays silent. The full completion buffer
 * is still handed to `extractReasoning` + `parseToolCall` at step end, so
 * this module never replaces final parsing — it only unlocks UI latency.
 *
 * State machine:
 *   preamble      → scanning for reasoning-open tag or JSON start `{`
 *   inside_think  → streaming reasoning until the configured close tag
 *   json_tool     → inside JSON, scanning for the outer "tool" name
 *   json_text     → tool was "reply", scanning for args.text string start
 *   reply_text    → streaming decoded args.text chars until the closing "
 *   done          → past reply text (or unsupported tool); swallow rest
 */

const TOOL_FIELD_RE = /"tool"\s*:\s*"([^"\\]+)"/;
const TEXT_FIELD_RE = /"text"\s*:\s*"/;
const DEFAULT_REASONING_OPEN_TAG = "<think>";
const DEFAULT_REASONING_CLOSE_TAG = "</think>";

export type StreamParseEvent =
  | { kind: "reasoning_open" }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "reasoning_close" }
  | { kind: "reply_text_open" }
  | { kind: "reply_text_delta"; text: string }
  | { kind: "reply_text_close" };

export interface StreamParser {
  /** Feed a chunk of raw model text; returns any events produced. */
  push(chunk: string): StreamParseEvent[];
  /** Flush pending state at stream end; emits close events if needed. */
  end(): StreamParseEvent[];
}

export interface StreamParserOptions {
  preOpenedThink?: boolean;
  reasoningOpenTag?: string;
  reasoningCloseTag?: string;
}

type ParserState =
  | "preamble"
  | "inside_think"
  | "json_tool"
  | "json_text"
  | "reply_text"
  | "done";

type EscapeMode = null | "simple" | "unicode";

interface EscapeCarry {
  mode: EscapeMode;
  unicodeHex: string;
}

export function createStreamParser(options: StreamParserOptions = {}): StreamParser {
  const reasoningOpenTag = options.reasoningOpenTag ?? DEFAULT_REASONING_OPEN_TAG;
  const reasoningCloseTag = options.reasoningCloseTag ?? DEFAULT_REASONING_CLOSE_TAG;
  const openRe = new RegExp(escapeRegex(reasoningOpenTag));
  const closeRe = new RegExp(escapeRegex(reasoningCloseTag));
  const closeHoldbackLen = Math.max(16, reasoningCloseTag.length);
  let state: ParserState = options.preOpenedThink ? "inside_think" : "preamble";
  let buffer = "";
  let carry: EscapeCarry = { mode: null, unicodeHex: "" };

  const advance = (): StreamParseEvent[] => {
    const out: StreamParseEvent[] = [];
    let keepGoing = true;
    while (keepGoing) {
      keepGoing = false;

      if (state === "preamble") {
        const openMatch = buffer.match(openRe);
        const braceIdx = buffer.indexOf("{");
        if (
          openMatch &&
          openMatch.index !== undefined &&
          (braceIdx === -1 || openMatch.index < braceIdx)
        ) {
          buffer = buffer.slice(openMatch.index + openMatch[0].length);
          state = "inside_think";
          out.push({ kind: "reasoning_open" });
          keepGoing = true;
          continue;
        }
        if (braceIdx !== -1) {
          buffer = buffer.slice(braceIdx);
          state = "json_tool";
          keepGoing = true;
          continue;
        }
        buffer = holdPossibleTagStart(buffer, reasoningOpenTag);
        continue;
      }

      if (state === "inside_think") {
        const closeMatch = buffer.match(closeRe);
        if (closeMatch && closeMatch.index !== undefined) {
          const before = buffer.slice(0, closeMatch.index);
          if (before.length > 0) {
            out.push({ kind: "reasoning_delta", text: before });
          }
          out.push({ kind: "reasoning_close" });
          buffer = buffer.slice(closeMatch.index + closeMatch[0].length);
          state = "preamble";
          keepGoing = true;
          continue;
        }
        const cutAt = findSafeReasoningEmitIndex(buffer, reasoningCloseTag, closeHoldbackLen);
        const emit = buffer.slice(0, cutAt);
        if (emit.length > 0) {
          out.push({ kind: "reasoning_delta", text: emit });
          buffer = buffer.slice(cutAt);
        }
        continue;
      }

      if (state === "json_tool") {
        const m = buffer.match(TOOL_FIELD_RE);
        if (m && m.index !== undefined) {
          const tool = m[1]!;
          buffer = buffer.slice(m.index + m[0].length);
          state = tool === "reply" ? "json_text" : "done";
          keepGoing = true;
          continue;
        }
        continue;
      }

      if (state === "json_text") {
        const m = buffer.match(TEXT_FIELD_RE);
        if (m && m.index !== undefined) {
          buffer = buffer.slice(m.index + m[0].length);
          state = "reply_text";
          out.push({ kind: "reply_text_open" });
          keepGoing = true;
          continue;
        }
        continue;
      }

      if (state === "reply_text") {
        const result = readReplyTextChars(buffer, carry);
        carry = result.carry;
        if (result.chars.length > 0) {
          out.push({ kind: "reply_text_delta", text: result.chars });
        }
        buffer = buffer.slice(result.consumed);
        if (result.closed) {
          out.push({ kind: "reply_text_close" });
          state = "done";
          keepGoing = true;
        }
        continue;
      }

      if (state === "done") {
        buffer = "";
      }
    }
    return out;
  };

  return {
    push(chunk: string): StreamParseEvent[] {
      if (chunk.length === 0) return [];
      buffer += chunk;
      return advance();
    },
    end(): StreamParseEvent[] {
      const out = advance();
      if (state === "inside_think") {
        if (buffer.length > 0) {
          out.push({ kind: "reasoning_delta", text: buffer });
          buffer = "";
        }
        out.push({ kind: "reasoning_close" });
        state = "done";
      } else if (state === "reply_text") {
        if (buffer.length > 0) {
          out.push({ kind: "reply_text_delta", text: buffer });
          buffer = "";
        }
        out.push({ kind: "reply_text_close" });
        state = "done";
      } else {
        state = "done";
      }
      return out;
    },
  };
}

interface ReadReplyTextResult {
  chars: string;
  consumed: number;
  closed: boolean;
  carry: EscapeCarry;
}

/**
 * Walk a chunk of the `reply.args.text` body decoding JSON string escapes as
 * we go. Returns the decoded slice, how many source chars were consumed,
 * whether the closing `"` was reached, and any escape state carried over to
 * the next chunk. `\uXXXX` is handled across chunk boundaries so a hex
 * sequence split by the network doesn't emit garbage.
 */
function readReplyTextChars(
  buffer: string,
  incoming: EscapeCarry,
): ReadReplyTextResult {
  let out = "";
  let i = 0;
  let mode = incoming.mode;
  let unicodeHex = incoming.unicodeHex;

  while (i < buffer.length) {
    if (mode === "unicode") {
      const c = buffer[i]!;
      if (/[0-9a-fA-F]/.test(c)) {
        unicodeHex += c;
        i++;
        if (unicodeHex.length === 4) {
          out += String.fromCharCode(parseInt(unicodeHex, 16));
          unicodeHex = "";
          mode = null;
        }
        continue;
      }
      // Malformed escape — bail out of unicode mode and re-interpret `c`.
      mode = null;
      unicodeHex = "";
    }
    if (mode === "simple") {
      const c = buffer[i]!;
      if (c === "u") {
        mode = "unicode";
        unicodeHex = "";
        i++;
        continue;
      }
      out += decodeSimpleEscape(c);
      mode = null;
      i++;
      continue;
    }
    const c = buffer[i]!;
    if (c === "\\") {
      mode = "simple";
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      return {
        chars: out,
        consumed: i,
        closed: true,
        carry: { mode: null, unicodeHex: "" },
      };
    }
    out += c;
    i++;
  }
  return {
    chars: out,
    consumed: i,
    closed: false,
    carry: { mode, unicodeHex },
  };
}

function decodeSimpleEscape(c: string): string {
  switch (c) {
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    default:
      return c;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function holdPossibleTagStart(buffer: string, tag: string): string {
  const maxProbe = Math.min(buffer.length, Math.max(1, tag.length - 1));
  for (let len = maxProbe; len > 0; len -= 1) {
    if (buffer.endsWith(tag.slice(0, len))) {
      return buffer.slice(-len);
    }
  }
  return "";
}

function findSafeReasoningEmitIndex(
  buffer: string,
  closeTag: string,
  holdbackLen: number,
): number {
  const window = buffer.slice(-Math.min(buffer.length, holdbackLen));
  const overlap = longestTrailingPrefix(window, closeTag);
  return buffer.length - overlap;
}

function longestTrailingPrefix(buffer: string, prefix: string): number {
  const maxProbe = Math.min(buffer.length, prefix.length - 1);
  for (let len = maxProbe; len > 0; len -= 1) {
    if (buffer.endsWith(prefix.slice(0, len))) {
      return len;
    }
  }
  return 0;
}
