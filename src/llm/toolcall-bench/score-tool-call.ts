import type { OpenAiToolCall } from "../provider/completion-types.js";
import type { BenchCase } from "./bench-cases.js";

/**
 * What one try of one case came back as, worst first:
 * - `error`: the request itself failed (network, refusal, timeout);
 * - `no_call`: the model answered in text and called nothing;
 * - `parse_failure`: it called a tool, but the arguments are not a JSON object;
 * - `wrong_tool`: valid JSON, but another tool than the case asks for;
 * - `missing_args`: the right tool, but a required argument is absent or empty;
 * - `ok`: the right tool with every required argument.
 */
export type TryOutcome =
  | "error"
  | "no_call"
  | "parse_failure"
  | "wrong_tool"
  | "missing_args"
  | "ok";

/** The part of a completion the score reads. */
export interface TryReply {
  content: string;
  toolCalls?: ReadonlyArray<OpenAiToolCall> | undefined;
}

export interface TryScore {
  outcome: TryOutcome;
  /** The tool the model called first, when it called one. */
  calledTool?: string;
  /** Required arguments the call left out, for `missing_args`. */
  missingArgs?: readonly string[];
}

function parseArguments(raw: string): Record<string, unknown> | null {
  // An empty arguments string is how some servers spell "{}".
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * Score one reply against its case. Only the first tool call counts: the
 * case asks for exactly one, and a model that adds a second call has
 * still either picked the right first tool or not.
 */
export function scoreToolCall(bench: BenchCase, reply: TryReply): TryScore {
  const call = reply.toolCalls?.[0];
  if (!call) return { outcome: "no_call" };
  const calledTool = call.function.name;
  const args = parseArguments(call.function.arguments);
  if (!args) return { outcome: "parse_failure", calledTool };
  if (calledTool !== bench.expectedTool) {
    return { outcome: "wrong_tool", calledTool };
  }
  const missingArgs = bench.requiredArgs.filter((name) => !isPresent(args[name]));
  if (missingArgs.length > 0) {
    return { outcome: "missing_args", calledTool, missingArgs };
  }
  return { outcome: "ok", calledTool };
}
