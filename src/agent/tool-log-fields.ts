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
 * Tools whose path argument and error text are safe to log. An os.fs
 * error names the path and what went wrong; other tools' errors are not
 * that tame: an `os.shell.run` failure starts with the command line
 * (which can carry a token) and echoes its output, and an MCP tool's
 * `path`/`from` argument can be a URL or an email address. Those keep
 * only `errorName`.
 */
const LOGGABLE_TOOL_PREFIX = "os.fs.";

/** An errno-style code (`ENOENT`); any other `errorCode` value is not logged. */
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

export interface ToolLogFields {
  path?: string;
  reason?: string;
  errorName?: string;
  /** An errno-style code such as `ENOENT`; never a message. */
  errorCode?: string;
}

/**
 * Extra fields for the `tool executed` log line: for an os.fs call, the
 * path it named (never any file contents) and, when it failed, the first
 * line of its error; for any failed call, its error name and code. Without them a loop of failing calls (ATO-308: a planner
 * reading /dev/null step after step) shows in the log only as a tool
 * name and a status. Both are clipped so one long argument cannot bloat
 * the local log.
 */
export function toolLogFields(
  args: Readonly<Record<string, unknown>> | undefined,
  result: CompressedToolResult,
): ToolLogFields {
  const fields: ToolLogFields = {};
  const loggable = result.tool.startsWith(LOGGABLE_TOOL_PREFIX);
  const path = loggable ? pathOf(args) : undefined;
  if (path !== undefined) fields.path = path;
  if (result.status !== "error") return fields;
  const reason = loggable ? firstLine(result.summary) : undefined;
  if (reason !== undefined) fields.reason = reason;
  if (typeof result.details.errorName === "string") {
    fields.errorName = result.details.errorName;
  }
  const code = result.details.errorCode;
  if (typeof code === "string" && ERRNO_CODE.test(code)) {
    fields.errorCode = code;
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

/**
 * The first non-blank line of the error, skipping the compressor's
 * `key: ` signature: that is a copy of whichever later line looked like
 * an error, which for an os.fs.edit miss can be the quoted file text on
 * its second line.
 */
function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "" && !part.startsWith("key: "));
  return line === undefined ? undefined : clip(line);
}

function clip(text: string): string {
  return text.length > TOOL_LOG_FIELD_MAX_CHARS
    ? `${text.slice(0, TOOL_LOG_FIELD_MAX_CHARS)}…`
    : text;
}
