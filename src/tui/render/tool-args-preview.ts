const DEFAULT_MAX_LENGTH = 160;

/**
 * Collapse a tool's args object into a one-line preview suitable for the
 * collapsed tool-card header. Respects `maxLength` to avoid dominating
 * the chat log on nested objects or inline file contents.
 */
export function previewToolArgs(
  args: Record<string, unknown>,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  if (rendered.length <= maxLength) return rendered;
  return `${rendered.slice(0, maxLength - 1)}…`;
}

/**
 * Pretty-print args as a multi-line block for the expanded view. JSON is
 * safe to re-parse, keeps strings escaped, and lets tests diff against a
 * canonical form.
 */
export function formatToolArgsBlock(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return "(no args)";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "[unserialisable args]";
  }
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const clipped = value.length > 60 ? `${value.slice(0, 59)}…` : value;
    return JSON.stringify(clipped);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json.length > 60) return `${json.slice(0, 59)}…`;
    return json;
  } catch {
    return "[object]";
  }
}
