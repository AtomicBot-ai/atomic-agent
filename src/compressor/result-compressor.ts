import type { ToolApprovalRecord } from "../approval/approval-ledger.js";

export interface RawToolResult {
  tool: string;
  status: "ok" | "error";
  output: string;
  details?: Record<string, unknown>;
  /**
   * Lines kept verbatim AHEAD of the compressed output — the shell's
   * `$ command` / `exit:` header. They are never counted as tail lines
   * and never the part an overflow cut removes, so the summary always
   * says what ran and how it ended. Omitted, the summary is exactly what
   * it was before the field existed.
   */
  head?: string;
}

export interface CompressedToolResult {
  tool: string;
  status: "ok" | "error";
  summary: string;
  details: Record<string, unknown>;
  truncated: boolean;
  /**
   * Prompted approvals answered while the call ran. Stamped by the batch
   * executor, never by a tool; see `approval-ledger.ts`.
   */
  approvals?: readonly ToolApprovalRecord[];
}

export interface CompressorOptions {
  maxSummaryLength: number;
  maxTailLines: number;
  /**
   * Which end of the output survives when the summary is still over
   * `maxSummaryLength` after the tail-line cut.
   *
   * `head` (the default) keeps the beginning — right for a page, a file
   * or a document, which are read from the top.
   *
   * `tail` keeps `head` and the key-error line, then the END of the
   * output. It exists for command output: the tail-line cut above already
   * decided the last lines are what matters, and slicing the joined text
   * from the front then threw those very lines away. A shell summary
   * whose own command echo filled the budget reached the model as the
   * command, a few bytes of output and `… [truncated]` — the model could
   * not see the result of anything it ran, so it kept running variants.
   */
  overflow: "head" | "tail";
}

const DEFAULTS: CompressorOptions = {
  maxSummaryLength: 400,
  maxTailLines: 12,
  overflow: "head",
};

const TRUNCATED_MARKER = "… [truncated]";

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
  const head = (raw.head ?? "").replace(/\r\n/g, "\n").trimEnd();
  const { text: tail, truncated: tailTruncated } = extractTail(
    normalised,
    merged.maxTailLines,
  );
  const signature = extractSignature(normalised, raw.status);
  const { summary, overLength } = assemble(head, signature, tail, merged);
  return {
    tool: raw.tool,
    status: raw.status,
    summary,
    details: raw.details ?? {},
    truncated: tailTruncated || overLength,
  };
}

function assemble(
  head: string,
  signature: string,
  tail: string,
  options: CompressorOptions,
): { summary: string; overLength: boolean } {
  const joined = [head, signature, tail]
    .filter((part) => part.length > 0)
    .join("\n");
  if (joined.length <= options.maxSummaryLength) {
    return { summary: joined, overLength: false };
  }
  if (options.overflow === "tail") {
    const pinned = [head, signature].filter((part) => part.length > 0);
    const pinnedLength = pinned.reduce((acc, part) => acc + part.length + 1, 0);
    const room =
      options.maxSummaryLength - pinnedLength - TRUNCATED_MARKER.length - 1;
    // Below a useful minimum the pinned part alone is the problem (a
    // command line longer than the whole budget): fall back to the head
    // cut rather than keep a sliver of output under an oversized header.
    if (room >= 64) {
      let kept = tail.slice(tail.length - room);
      // Start on a whole line when one begins near the cut, so the first
      // kept line is not a fragment of a path or a number.
      const firstBreak = kept.indexOf("\n");
      if (firstBreak >= 0 && firstBreak < Math.min(160, kept.length / 2)) {
        kept = kept.slice(firstBreak + 1);
      }
      return {
        summary: [...pinned, TRUNCATED_MARKER, kept].join("\n"),
        overLength: true,
      };
    }
  }
  return {
    summary: `${joined.slice(0, options.maxSummaryLength - 15)}\n${TRUNCATED_MARKER}`,
    overLength: true,
  };
}

function extractTail(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  if (text.length === 0) return { text: "", truncated: false };
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines)
    return { text: lines.join("\n"), truncated: false };
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

const TRACEBACK_HEADER = /traceback \(most recent call last\)/i;
/** The line a Python traceback ends on: `ModuleNotFoundError: No module named 'PIL'`. */
const PYTHON_EXCEPTION_LINE =
  /^\s*[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b/;

function extractSignature(text: string, status: "ok" | "error"): string {
  if (status === "ok") return "";
  const lines = text.split("\n");
  // A one-line error IS its own key line. Repeating it as `key: …` above
  // itself doubled the summary and pushed the provider's actual reason
  // past the cap (`vision call failed: … 400: {…` cut mid-sentence).
  if (lines.filter((line) => line.trim().length > 0).length === 1) return "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const pattern of ERROR_MARKERS) {
      if (!pattern.test(line)) continue;
      // `Traceback (most recent call last):` names no error at all; the
      // exception it is about is the last line of the block. Without this
      // the key line of every Python failure was the header, and the cap
      // then cut the real `…Error:` line off the end.
      if (TRACEBACK_HEADER.test(line)) {
        for (let j = lines.length - 1; j > i; j -= 1) {
          if (PYTHON_EXCEPTION_LINE.test(lines[j]!)) {
            return `key: ${lines[j]!.trim().slice(0, 180)}`;
          }
        }
      }
      return `key: ${line.trim().slice(0, 180)}`;
    }
  }
  return "";
}
