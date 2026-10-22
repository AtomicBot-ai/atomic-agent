import type { CompressedToolResult } from "../compressor/result-compressor.js";

/** Longest path or reason a `tool executed` log line carries. */
export const TOOL_LOG_FIELD_MAX_CHARS = 200;

/**
 * Argument keys that name the file or folder a call acted on, in the
 * order they are tried. `path` covers the os.fs tools; `from` covers a
 * single `os.fs.move`.
 */
const PATH_ARG_KEYS = ["path", "from"] as const;

/**
 * Extra fields for the `tool executed` log line: the path the call named
 * (never any file contents) and, for a failed call, the first line of
 * its error. Without them a loop of failing calls (ATO-308: a planner
 * reading /dev/null step after step) shows in the log only as a tool
 * name and a status. Both are clipped so one long argument cannot bloat
 * the local log.
 */
export function toolLogFields(
  args: Readonly<Record<string, unknown>> | undefined,
  result: CompressedToolResult,
): { path?: string; reason?: string; errorName?: string } {
  const fields: { path?: string; reason?: string; errorName?: string } = {};
  const path = pathOf(args);
  if (path !== undefined) fields.path = path;
  if (result.status !== "error") return fields;
  const reason = firstLine(result.summary);
  if (reason !== undefined) fields.reason = reason;
  if (typeof result.details.errorName === "string") {
    fields.errorName = result.details.errorName;
  }
  return fields;
}

function pathOf(
  args: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (args === undefined) return undefined;
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return clip(value);
  }
  return undefined;
}

function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? undefined : clip(line);
}

function clip(text: string): string {
  return text.length > TOOL_LOG_FIELD_MAX_CHARS
    ? `${text.slice(0, TOOL_LOG_FIELD_MAX_CHARS)}…`
    : text;
}
