/**
 * The part of a CI job log worth showing a model (ATO-2331).
 *
 * An Actions job log is often megabytes: setup steps, dependency
 * installs, then the failure at the very end. Two bounds apply. While
 * reading, only the last `maxBytes` of the stream are kept, so a huge
 * log never sits in memory whole. After reading, the text is cleaned
 * (timestamps, ANSI colour codes) and cut to the last lines, with the
 * `##[error]` annotations pulled forward because they are often the
 * one line that names the failing file. Same shape as Qwen Code's
 * `/autofix-pr` `ci-log.ts` (Apache-2.0): tail plus error lines.
 */

import { scrubGithubToken } from "./github-token.js";

/** Bytes of the stream kept while reading. */
export const LOG_READ_MAX_BYTES = 256 * 1024;
/** Lines of the cleaned tail shown. */
export const LOG_TAIL_MAX_LINES = 80;
/** Characters of the cleaned tail shown. */
export const LOG_TAIL_MAX_CHARS = 6_000;
/** `##[error]` lines shown above the tail. */
export const LOG_MAX_ERROR_LINES = 10;

export interface LogTail {
  text: string;
  errorLines: string[];
  /** True when anything was dropped: bytes while reading, or lines/characters after. */
  truncated: boolean;
  /** Lines in the part that was read. */
  totalLines: number;
}

/**
 * Read a response body keeping only its last `maxBytes`. The first
 * (possibly partial) line of a cut buffer is dropped so the tail never
 * starts mid-line or mid-character.
 */
export async function readBodyTail(
  res: Response,
  maxBytes: number = LOG_READ_MAX_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    chunks.push(value);
    kept += value.byteLength;
    while (kept > maxBytes && chunks.length > 1) {
      kept -= chunks.shift()!.byteLength;
      dropped = true;
    }
    if (kept > maxBytes && chunks.length === 1) {
      const only = chunks[0]!;
      chunks[0] = only.subarray(only.byteLength - maxBytes);
      kept = maxBytes;
      dropped = true;
    }
  }
  const bytes = Buffer.concat(chunks);
  let text = bytes.toString("utf8");
  if (dropped) {
    const nl = text.indexOf("\n");
    text = nl === -1 ? "" : text.slice(nl + 1);
  }
  return { text, truncated: dropped };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function cleanLine(line: string): string {
  return line.replace(/\r$/, "").replace(TIMESTAMP, "").replace(ANSI, "");
}

/** Clean a log and keep its error annotations plus its last lines, both bounded. */
export function extractLogTail(
  raw: string,
  options: {
    maxLines?: number;
    maxChars?: number;
    maxErrorLines?: number;
    alreadyTruncated?: boolean;
  } = {},
): LogTail {
  const maxLines = options.maxLines ?? LOG_TAIL_MAX_LINES;
  const maxChars = options.maxChars ?? LOG_TAIL_MAX_CHARS;
  const maxErrorLines = options.maxErrorLines ?? LOG_MAX_ERROR_LINES;
  const lines = scrubGithubToken(raw).split("\n").map(cleanLine);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  const errorLines = lines
    .filter((l) => l.includes("##[error]"))
    .slice(0, maxErrorLines)
    .map((l) => l.slice(0, 500));

  let truncated = options.alreadyTruncated === true;
  let tail = lines;
  if (tail.length > maxLines) {
    tail = tail.slice(tail.length - maxLines);
    truncated = true;
  }
  let text = tail.join("\n");
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    const nl = text.indexOf("\n");
    if (nl !== -1) text = text.slice(nl + 1);
    truncated = true;
  }
  return { text, errorLines, truncated, totalLines: lines.length };
}
