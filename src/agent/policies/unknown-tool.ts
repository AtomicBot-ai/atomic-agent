/**
 * A call to a tool name the registry does not hold.
 *
 * Models guess names: `os.grep` for `os.fs.grep`, `os.shel.run`,
 * `os.browser.navigate`, an invented `mcp.example.toolkit`, a
 * placeholder like `function_name`. That used to end the whole turn —
 * valid calls of the same step included — with nothing said to the
 * model. Now the call gets an error result naming the closest real
 * tools, and the model corrects itself on the next step. A model that
 * keeps calling only tools that do not exist is still stopped: after
 * {@link UNKNOWN_TOOL_STREAK_LIMIT} such steps in a row the step throws
 * as before.
 *
 * Suggestions are a hint in the result text only; a near miss is never
 * resolved to a real tool here (`tool-name-resolution.ts` owns the
 * separator / case forms that are safe to resolve silently).
 */
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { UnregisteredToolNameClass } from "../../llm/index.js";
import { toolSetAdmits, type StepToolSet } from "./step-tool-set.js";

/** Unknown-tool-only steps in a row after which the step throws. */
export const UNKNOWN_TOOL_STREAK_LIMIT = 3;

/** Most suggestions one result names. */
export const UNKNOWN_TOOL_MAX_SUGGESTIONS = 3;

/** Longest emitted name echoed back to the model. */
const ECHO_NAME_CHARS = 80;

/** Segments shared by many tools: matching one says nothing. */
const NAMESPACE_SEGMENTS = new Set(["os", "fs", "mcp", "tool", "tools"]);


/**
 * Per-turn count of steps in a row whose every call named a tool that
 * does not exist. Held by the loop like the claim-evidence notice
 * state; a step with any real call resets it.
 */
export interface UnknownToolStreak {
  /** Record one step; returns the streak length after it. */
  record(unknownOnly: boolean): number;
}

export function createUnknownToolStreak(): UnknownToolStreak {
  let streak = 0;
  return {
    record(unknownOnly) {
      streak = unknownOnly ? streak + 1 : 0;
      return streak;
    },
  };
}

function segmentsOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[._\-\s]+/)
    .filter((segment) => segment.length > 0);
}

function segmentsMatch(emitted: string, real: string): boolean {
  if (emitted === real) return true;
  if (emitted.length < 3 || real.length < 3) return false;
  return emitted.startsWith(real) || real.startsWith(emitted);
}

/** Plain Levenshtein distance; names are short, the pool is ~100. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Up to `max` registered names closest to `emitted`, best first. A
 * candidate qualifies by sharing a meaningful name segment (`grep` in
 * `os.grep` → `os.fs.grep`; `shel` is a prefix of `shell`) or by a small
 * edit distance on the whole name. Shared segments rank first, then
 * distance, then name, so the order is deterministic.
 */
export function closestToolNames(
  emitted: string,
  candidates: readonly string[],
  max: number = UNKNOWN_TOOL_MAX_SUGGESTIONS,
): string[] {
  const wanted = segmentsOf(emitted).filter(
    (segment) => !NAMESPACE_SEGMENTS.has(segment),
  );
  const flat = emitted.toLowerCase();
  const threshold = Math.max(1, Math.floor(flat.length / 4));
  const scored: Array<{ name: string; shared: number; distance: number }> = [];
  for (const name of new Set(candidates)) {
    if (name === emitted) continue;
    const own = segmentsOf(name);
    const shared = wanted.filter((segment) =>
      own.some((real) => segmentsMatch(segment, real)),
    ).length;
    const distance = editDistance(flat, name.toLowerCase());
    if (shared === 0 && distance > threshold) continue;
    scored.push({ name, shared, distance });
  }
  scored.sort(
    (a, b) =>
      b.shared - a.shared ||
      a.distance - b.distance ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return scored.slice(0, Math.max(0, max)).map((entry) => entry.name);
}

export function unregisteredToolNameClass(
  emitted: string,
  suggestions: readonly string[],
): UnregisteredToolNameClass {
  if (suggestions.length > 0) return "near_miss";
  if (emitted.toLowerCase().startsWith("mcp.")) return "mcp_like";
  return "other";
}

function echoName(name: string): string {
  const flat = name.replace(/\s+/g, " ");
  return flat.length > ECHO_NAME_CHARS
    ? `${flat.slice(0, ECHO_NAME_CHARS)}…`
    : flat;
}

export function formatUnknownToolMessage(
  emitted: string,
  suggestions: readonly string[],
): string {
  const head = `no tool named \`${echoName(emitted)}\` in this agent; nothing ran.`;
  return suggestions.length > 0
    ? `${head} Closest: ${suggestions.join(", ")}. Call one of the listed tools.`
    : `${head} Call only tools listed in your instructions; do not invent tool names.`;
}

/**
 * The error result an unregistered call gets in its slot instead of
 * running. `details.unregisteredTool` marks it on the trace row.
 */
export function unknownToolResult(
  emitted: string,
  candidates: readonly string[],
): CompressedToolResult {
  const suggestions = closestToolNames(emitted, candidates);
  return compressToolResult({
    tool: emitted,
    status: "error",
    output: formatUnknownToolMessage(emitted, suggestions),
    details: { unregisteredTool: true, suggestions },
  });
}

/**
 * The dispatch-time refusal for a call the registry does not hold, or
 * `null` when it does. Suggestions come from the registered names the
 * step may run (its tool set, when it has one).
 */
export function refuseUnregisteredTool(
  tool: string,
  registry: ToolRegistry,
  toolSet?: StepToolSet,
): CompressedToolResult | null {
  if (registry.has(tool)) return null;
  const names = registry
    .list()
    .map((definition) => definition.name)
    .filter((name) => toolSet === undefined || toolSetAdmits(toolSet, name));
  return unknownToolResult(tool, names);
}
