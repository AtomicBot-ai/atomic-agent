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
    const reasoning = body.slice((match?.index ?? 0) + (match?.[0].length ?? 0)).trim();
    return {
      reasoning,
      body: body.slice(0, match?.index ?? 0).trim(),
    };
  }
  body = body.trim();
  return {
    reasoning: collected.join("\n\n"),
    body,
  };
}

export function parseToolCall(
  raw: string,
  options: ReasoningTagOptions = {},
): ToolCallPayload {
  const extracted = extractReasoning(raw, options);
  const jsonText = extractJsonObject(extracted.body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ToolCallParseError(
      `invalid tool-call JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolCallParseError("tool-call root must be a JSON object");
  }

  const normalized = normalizeToolCall(parsed as Record<string, unknown>);
  return extracted.reasoning.length > 0
    ? { ...normalized, reasoning: extracted.reasoning }
    : normalized;
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

function extractJsonObject(raw: string): string {
  const input = raw.trim();
  if (input.length === 0) {
    throw new ToolCallParseError("tool-call body is empty");
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let idx = 0; idx < input.length; idx += 1) {
    const ch = input[idx]!;
    if (start === -1) {
      if (ch === "{") {
        start = idx;
        depth = 1;
      } else if (!/\s/.test(ch)) {
        continue;
      }
      continue;
    }

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
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, idx + 1);
      }
    }
  }

  if (start === -1) {
    throw new ToolCallParseError("tool-call JSON object not found");
  }
  throw new ToolCallParseError("tool-call JSON object is incomplete");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
