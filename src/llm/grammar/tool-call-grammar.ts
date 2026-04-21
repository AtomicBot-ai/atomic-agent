import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getConfig } from "../../config/index.js";

/**
 * Loads the GBNF grammar used by llama-server to constrain tool-call output
 * to a strictly-shaped JSON object. We keep the source in grammars/ so
 * operators can hot-swap it without rebuilding the binary.
 */
export async function loadToolCallGrammar(): Promise<string> {
  const { paths } = getConfig();
  const file = resolve(paths.grammarsDir, "tool-call.gbnf");
  const buffer = await readFile(file, "utf8");
  return buffer.trim();
}

export interface ToolCallPayload {
  tool: string;
  args: Record<string, unknown>;
  /**
   * Content of all `<think>...</think>` blocks found in the raw completion,
   * joined by blank lines. Empty string when the model did not emit any
   * reasoning. Never participates in tool-call validation — purely
   * informational for the UI / telemetry.
   */
  reasoning: string;
}

export class ToolCallParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "ToolCallParseError";
  }
}

const THINK_OPEN_RE = /<think\b[^>]*>/i;
const THINK_PAIR_RE = /<think\b[^>]*>([\s\S]*?)<\/think\s*>/gi;

export interface ExtractedReasoning {
  /** Concatenated text from every `<think>` block, trimmed. */
  reasoning: string;
  /** Input with all think blocks stripped — safe to feed into JSON extractors. */
  body: string;
}

/**
 * Strips `<think>...</think>` blocks from a raw model completion and returns
 * the reasoning text separately.
 *
 * Handles three drift shapes observed with reasoning-tuned gguf models:
 * 1. Balanced pairs — standard case, stripped out.
 * 2. Unclosed trailing `<think>...` (truncation by `n_predict` or stop
 *    sequence mid-thought) — the remainder of the buffer is treated as
 *    reasoning and removed from `body` so the JSON parser doesn't choke on
 *    a stray `<` token. `body` is whatever preceded the opening tag.
 * 3. No think tags at all — passthrough.
 *
 * Also tolerates multiple blocks and preserves JSON that appears *after*
 * a closing `</think>`, which is the canonical layout we want to reach.
 */
export function extractReasoning(raw: string): ExtractedReasoning {
  const collected: string[] = [];
  let body = raw.replace(THINK_PAIR_RE, (_match, inner: string) => {
    collected.push(inner.trim());
    return "";
  });

  const stray = body.match(THINK_OPEN_RE);
  if (stray && typeof stray.index === "number") {
    const head = body.slice(0, stray.index);
    const tail = body.slice(stray.index + stray[0].length);
    collected.push(tail.trim());
    body = head;
  }

  const reasoning = collected
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");

  return { reasoning, body: body.trim() };
}

/**
 * Returns the first top-level `{ ... }` slice in `text`, respecting JSON
 * string escapes so braces inside string values do not break balancing.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonLenient(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch (firstErr) {
    const slice = extractFirstJsonObject(raw);
    if (!slice) throw firstErr;
    try {
      return JSON.parse(slice);
    } catch {
      throw firstErr;
    }
  }
}

const RESERVED_ARG_KEYS = new Set([
  "tool",
  "name",
  "action",
  "args",
  "arguments",
]);

function collectFlatArgFields(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (RESERVED_ARG_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolves `args` from `args`, or OpenAI-style `arguments` (object or JSON
 * string). Returns null when no usable payload is present.
 */
function resolveArgsObject(
  candidate: Record<string, unknown>,
): Record<string, unknown> | null {
  const fromArgs = candidate.args;
  if (
    fromArgs &&
    typeof fromArgs === "object" &&
    !Array.isArray(fromArgs)
  ) {
    return fromArgs as Record<string, unknown>;
  }

  const fromInv = candidate.arguments;
  if (fromInv && typeof fromInv === "object" && !Array.isArray(fromInv)) {
    return fromInv as Record<string, unknown>;
  }
  if (typeof fromInv === "string" && fromInv.trim().length > 0) {
    try {
      const parsed = JSON.parse(fromInv.trim()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parses a tool-call JSON produced by llama-server under the GBNF grammar.
 * We validate the canonical shape (`tool: string`, `args: object`) and also
 * accept common drift shapes (`name`, OpenAI `arguments` object or JSON
 * string, `action`, and flat fields alongside `tool`) when grammar decoding
 * is bypassed upstream.
 *
 * Reasoning-tuned models (`qwen3-thinking`, DeepSeek-R1 ports, etc.) often
 * prefix the JSON with `<think>...</think>` blocks. We strip those via
 * `extractReasoning` *before* JSON extraction so that braces inside the
 * thought process can never confuse `extractFirstJsonObject`, and so that
 * a truncated/unclosed `<think>` doesn't produce an "Unexpected token '<'"
 * parse failure. The reasoning text is preserved on the returned payload
 * for UIs / telemetry that want to surface it.
 */
export function parseToolCall(raw: string): ToolCallPayload {
  const { reasoning, body } = extractReasoning(raw);
  if (body.length === 0) {
    throw new ToolCallParseError(
      "tool-call body is empty after stripping <think> blocks",
      raw,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseJsonLenient(body);
  } catch (err) {
    throw new ToolCallParseError(
      `tool-call JSON is not parseable: ${(err as Error).message}`,
      body,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ToolCallParseError("tool-call must be an object", body);
  }
  const candidate = parsed as Record<string, unknown>;
  const hasToolName =
    typeof candidate.tool === "string" && candidate.tool.length > 0;
  const hasNameAlias =
    typeof candidate.name === "string" && candidate.name.length > 0;
  const hasActionAlias =
    typeof candidate.action === "string" && candidate.action.length > 0;

  let tool: string;
  if (hasToolName) {
    tool = candidate.tool as string;
  } else if (hasNameAlias) {
    tool = candidate.name as string;
  } else if (hasActionAlias) {
    // Some models / servers ignore GBNF and emit `action` plus flat params.
    tool = candidate.action as string;
  } else {
    throw new ToolCallParseError(
      "tool-call.tool must be a non-empty string",
      body,
    );
  }

  const argsObject = resolveArgsObject(candidate);
  const flatFields = collectFlatArgFields(candidate);
  const hasFlatFields = Object.keys(flatFields).length > 0;

  let args: Record<string, unknown>;
  if (argsObject) {
    args = argsObject;
  } else if (hasFlatFields) {
    args = flatFields;
  } else if (!hasToolName && (hasNameAlias || hasActionAlias)) {
    args = {};
  } else {
    throw new ToolCallParseError(
      "tool-call.args must be an object",
      body,
    );
  }

  return { tool, args, reasoning };
}
