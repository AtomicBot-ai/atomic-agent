import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_TOOL_CALL_GRAMMAR_PATH = resolve(HERE, "../../../grammars/tool-call.gbnf");

const require = createRequire(import.meta.url);

function readToolCallGrammarFromSea(): string | null {
  try {
    const sea: typeof import("node:sea") = require("node:sea");
    if (sea.isSea()) {
      const data = sea.getAsset("tool-call.gbnf");
      if (data) {
        if (typeof data === "string") {
          return data;
        }
        return Buffer.from(data).toString("utf8");
      }
    }
  } catch {
    // `node:sea` unavailable or asset missing
  }
  return null;
}
const DEFAULT_REASONING_OPEN_TAG = "<think>";
const DEFAULT_REASONING_CLOSE_TAG = "</think>";

export interface ExtractedReasoning {
  /** Concatenated text from every `<think>` block, trimmed. */
  reasoning: string;
  /** Input with all think blocks stripped. */
  body: string;
}

export interface ToolCallPayload {
  tool: string;
  args: Record<string, unknown>;
  reasoning?: string;
}

/**
 * Result of parsing one LLM completion.
 *
 * - `kind: "single"` — model emitted one `{tool, args}` object. The
 *   single call lives at `calls[0]`. This is the legacy shape; every
 *   pre-batch caller maps onto it.
 * - `kind: "batch"` — model emitted a JSON array of N `{tool, args}`
 *   objects. `calls.length >= 1`; the runtime caps `N` against
 *   `agent.maxParallelToolCalls`. Callers iterate `calls` and feed the
 *   result through the batch executor.
 *
 * `reasoning` is the full `<think>` block (or `reasoning_content`
 * channel text) for the whole completion — there is exactly one
 * per inference, regardless of `kind`.
 */
export interface ToolCallBatch {
  kind: "single" | "batch";
  calls: ToolCallPayload[];
  reasoning?: string;
}

export interface ReasoningTagOptions {
  openTag?: string;
  closeTag?: string;
}

export class ToolCallParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallParseError";
  }
}

export function loadToolCallGrammar(): string {
  const override = process.env.ATOMIC_AGENT_TOOL_CALL_GRAMMAR;
  if (typeof override === "string" && override.length > 0) {
    return readFileSync(override, "utf8");
  }
  const nextToBinary = join(dirname(process.execPath), "grammars", "tool-call.gbnf");
  if (existsSync(nextToBinary)) {
    return readFileSync(nextToBinary, "utf8");
  }
  if (existsSync(DEV_TOOL_CALL_GRAMMAR_PATH)) {
    return readFileSync(DEV_TOOL_CALL_GRAMMAR_PATH, "utf8");
  }
  const fromSea = readToolCallGrammarFromSea();
  if (fromSea !== null) {
    return fromSea;
  }
  throw new Error(
    "tool-call.gbnf not found (set ATOMIC_AGENT_TOOL_CALL_GRAMMAR, install grammars next to the binary, or run from a dev tree)",
  );
}

export function extractReasoning(
  raw: string,
  options: ReasoningTagOptions = {},
): ExtractedReasoning {
  const openTag = options.openTag ?? DEFAULT_REASONING_OPEN_TAG;
  const closeTag = options.closeTag ?? DEFAULT_REASONING_CLOSE_TAG;
  const pairRe = new RegExp(
    `${escapeRegex(openTag)}([\\s\\S]*?)${escapeRegex(closeTag)}`,
    "g",
  );
  const openRe = new RegExp(escapeRegex(openTag));
  const collected: string[] = [];
  let body = raw.replace(pairRe, (_match, inner: string) => {
    const text = inner.trim();
    if (text.length > 0) collected.push(text);
    return "";
  });
  if (openRe.test(body)) {
    const match = body.match(openRe);
    const prefix = body.slice(0, match?.index ?? 0).trim();
    const tail = body.slice((match?.index ?? 0) + (match?.[0].length ?? 0)).trim();
    const peeled = peelTrailingToolJson(tail);
    const reasoningParts = [...collected];
    if (peeled.prefix.length > 0) reasoningParts.push(peeled.prefix);
    return {
      reasoning: reasoningParts.join("\n\n"),
      body: peeled.jsonBody.length > 0 ? peeled.jsonBody : prefix,
    };
  }
  body = body.trim();
  return {
    reasoning: collected.join("\n\n"),
    body,
  };
}

/**
 * Legacy single-call parser. Returns the only call from the parsed
 * batch and throws if the model emitted >1 calls. Kept for back-compat
 * with callers that pre-date parallel tool calls (tests, replay, etc.).
 * Now accepts both `{tool, args}` and a single-element `[{tool, args}]`
 * since the grammar collapsed to array-only at runtime — the bare-
 * object form is still legal for callers that synthesise a completion
 * by hand (tests, replay scenarios). New code should prefer
 * `parseToolCalls`.
 */
export function parseToolCall(
  raw: string,
  options: ReasoningTagOptions = {},
): ToolCallPayload {
  const batch = parseToolCalls(raw, options);
  if (batch.calls.length > 1) {
    throw new ToolCallParseError(
      `parseToolCall received a batch of ${batch.calls.length} calls; use parseToolCalls`,
    );
  }
  return batch.reasoning !== undefined && batch.reasoning.length > 0
    ? { ...batch.calls[0]!, reasoning: batch.reasoning }
    : batch.calls[0]!;
}

/**
 * Parse one LLM completion into a batch of tool calls. Accepts either a
 * single `{tool, args}` object (legacy single-call shape) or a JSON array
 * of objects (parallel-batch shape). Reasoning is extracted once for the
 * whole completion and surfaced on the batch — never duplicated per call.
 *
 * Empty arrays are rejected here (validator-friendly: callers can rely
 * on `calls.length >= 1`). Oversized arrays are NOT rejected here — the
 * grammar caps the array length structurally and the step executor
 * applies the runtime soft cap from `agent.maxParallelToolCalls`. This
 * keeps the parser policy-free.
 */
export function parseToolCalls(
  raw: string,
  options: ReasoningTagOptions = {},
): ToolCallBatch {
  const extracted = extractReasoning(raw, options);
  const { jsonText, kind } = extractJsonRoot(extracted.body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ToolCallParseError(
      `invalid tool-call JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const reasoning = extracted.reasoning;
  if (kind === "object") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ToolCallParseError("tool-call root must be a JSON object");
    }
    const normalized = normalizeToolCall(parsed as Record<string, unknown>);
    return {
      kind: "single",
      calls: [normalized],
      ...(reasoning.length > 0 ? { reasoning } : {}),
    };
  }
  if (!Array.isArray(parsed)) {
    throw new ToolCallParseError("tool-call array root must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new ToolCallParseError("tool-call array must contain at least one call");
  }
  const calls: ToolCallPayload[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolCallParseError(
        `tool-call array entry ${i} must be a JSON object`,
      );
    }
    calls.push(normalizeToolCall(entry as Record<string, unknown>));
  }
  return {
    kind: "batch",
    calls,
    ...(reasoning.length > 0 ? { reasoning } : {}),
  };
}

function normalizeToolCall(payload: Record<string, unknown>): ToolCallPayload {
  const tool = readToolName(payload);
  if (tool.length === 0) {
    throw new ToolCallParseError("tool-call must include a non-empty tool name");
  }

  const args = readArgs(payload);
  return { tool, args };
}

function readToolName(payload: Record<string, unknown>): string {
  for (const key of ["tool", "name", "action"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function readArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.args ?? payload.arguments;
  if (nested !== undefined) {
    if (typeof nested === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(nested);
      } catch (error) {
        throw new ToolCallParseError(
          `tool-call arguments must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ToolCallParseError("tool-call args must be a JSON object");
      }
      return parsed as Record<string, unknown>;
    }
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      throw new ToolCallParseError("tool-call args must be a JSON object");
    }
    return nested as Record<string, unknown>;
  }

  const flatArgs = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !["tool", "name", "action"].includes(key)),
  );
  if (Object.keys(flatArgs).length === 0) {
    throw new ToolCallParseError("tool-call must include args");
  }
  return flatArgs;
}

interface ExtractedRoot {
  jsonText: string;
  kind: "object" | "array";
}

/**
 * Locate the first balanced JSON value at the start of `raw` after
 * skipping leading whitespace. Recognises both `{...}` (single call)
 * and `[...]` (batch) shapes; nested objects/arrays are bracket-counted
 * with proper string-escape awareness.
 */
/**
 * When the model never emits the reasoning-close sentinel but does emit
 * a tool-call JSON tail (common on Gemma channel-think + array-only
 * grammar), peel the JSON into `body` so `parseToolCalls` still runs.
 */
function peelTrailingToolJson(text: string): {
  prefix: string;
  jsonBody: string;
} {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { prefix: "", jsonBody: "" };
  }
  try {
    const { jsonText } = extractJsonRoot(trimmed);
    const start = trimmed.indexOf(jsonText);
    if (start < 0) {
      return { prefix: trimmed, jsonBody: "" };
    }
    return {
      prefix: trimmed.slice(0, start).trim(),
      jsonBody: jsonText,
    };
  } catch {
    return { prefix: trimmed, jsonBody: "" };
  }
}

/**
 * Locate a balanced JSON value in `raw` after skipping leading noise.
 * Small / degenerate models often emit false-start brackets inside
 * reasoning garbage (`[SFC]`, half-open `{...`) before a real tool-call
 * array. Prefer the first candidate that BOTH balances and `JSON.parse`s;
 * fall back to a clear incomplete/not-found error when nothing works.
 */
function extractJsonRoot(raw: string): ExtractedRoot {
  const input = raw.trim();
  if (input.length === 0) {
    throw new ToolCallParseError("tool-call body is empty");
  }

  let sawOpen = false;
  let sawIncomplete = false;

  for (let start = 0; start < input.length; start += 1) {
    const open = input[start]!;
    if (open !== "{" && open !== "[") {
      continue;
    }
    sawOpen = true;
    const kind: "object" | "array" = open === "{" ? "object" : "array";
    const extracted = tryExtractBalancedRoot(input, start, kind);
    if (extracted === null) {
      sawIncomplete = true;
      continue;
    }
    try {
      JSON.parse(extracted.jsonText);
      return extracted;
    } catch {
      // unbalanced-escape / truncated-but-closed junk; try next start
      continue;
    }
  }

  if (!sawOpen) {
    throw new ToolCallParseError("tool-call JSON value not found");
  }
  if (sawIncomplete) {
    throw new ToolCallParseError("tool-call JSON value is incomplete");
  }
  throw new ToolCallParseError("tool-call JSON value not found");
}

/**
 * Bracket-count from a known open at `start`. Returns null when the root
 * never closes (incomplete). Nested braces/brackets are tracked with
 * string-escape awareness identical to the pre-scan single-pass parser.
 */
function tryExtractBalancedRoot(
  input: string,
  start: number,
  kind: "object" | "array",
): ExtractedRoot | null {
  let depthCurly = kind === "object" ? 1 : 0;
  let depthSquare = kind === "array" ? 1 : 0;
  let inString = false;
  let escaped = false;

  for (let idx = start + 1; idx < input.length; idx += 1) {
    const ch = input[idx]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depthCurly += 1;
      continue;
    }
    if (ch === "}") {
      depthCurly -= 1;
      if (kind === "object" && depthCurly === 0 && depthSquare === 0) {
        return { jsonText: input.slice(start, idx + 1), kind: "object" };
      }
      continue;
    }
    if (ch === "[") {
      depthSquare += 1;
      continue;
    }
    if (ch === "]") {
      depthSquare -= 1;
      if (kind === "array" && depthSquare === 0 && depthCurly === 0) {
        return { jsonText: input.slice(start, idx + 1), kind: "array" };
      }
    }
  }
  return null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
