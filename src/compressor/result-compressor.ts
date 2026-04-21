export interface RawToolResult {
  tool: string;
  status: "ok" | "error";
  output: string;
  details?: Record<string, unknown>;
}

export interface CompressedToolResult {
  tool: string;
  status: "ok" | "error";
  summary: string;
  details: Record<string, unknown>;
  truncated: boolean;
}

export interface CompressorOptions {
  maxSummaryLength: number;
  maxTailLines: number;
}

const DEFAULTS: CompressorOptions = {
  maxSummaryLength: 400,
  maxTailLines: 12,
};

/**
 * Shrinks verbose tool output (test logs, grep hits, stack traces) into a
 * compact summary that fits the latest-result budget. We keep the last N
 * non-blank lines plus a structured signal (counts, top hits, key error).
 */
export function compressToolResult(
  raw: RawToolResult,
  options: Partial<CompressorOptions> = {},
): CompressedToolResult {
  const merged = { ...DEFAULTS, ...options };
  const normalised = raw.output.replace(/\r\n/g, "\n").trimEnd();
  const { text: tail, truncated: tailTruncated } = extractTail(
    normalised,
    merged.maxTailLines,
  );
  const signature = extractSignature(normalised, raw.status);
  const summaryParts = [signature, tail].filter((part) => part.length > 0);
  const joined = summaryParts.join("\n");
  const overLength = joined.length > merged.maxSummaryLength;
  const summary = overLength
    ? `${joined.slice(0, merged.maxSummaryLength - 15)}\n… [truncated]`
    : joined;
  return {
    tool: raw.tool,
    status: raw.status,
    summary,
    details: raw.details ?? {},
    truncated: tailTruncated || overLength,
  };
}

function extractTail(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  if (text.length === 0) return { text: "", truncated: false };
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return { text: lines.join("\n"), truncated: false };
  const slice = lines.slice(-maxLines);
  return {
    text: `… [omitted ${lines.length - maxLines} lines]\n${slice.join("\n")}`,
    truncated: true,
  };
}

const ERROR_MARKERS = [
  /error:/i,
  /failed:/i,
  /traceback \(most recent call last\)/i,
  /assertionerror/i,
  /exception:/i,
];

function extractSignature(text: string, status: "ok" | "error"): string {
  if (status === "ok") return "";
  const lines = text.split("\n");
  for (const line of lines) {
    for (const pattern of ERROR_MARKERS) {
      if (pattern.test(line)) {
        return `key: ${line.trim().slice(0, 180)}`;
      }
    }
  }
  return "";
}
