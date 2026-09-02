import { open, realpath, stat } from "node:fs/promises";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import {
  hashReadContent,
  READ_COVERAGE_DETAIL_KEY,
  splitReadLines,
  type ReadCoverageDetail,
} from "./fs-read-coverage.js";
import type { ToolDefinition } from "../tool-registry.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

interface ReadArgs {
  path: string;
  maxBytes: number;
  offset?: number;
  limit?: number;
  lineNumbers: boolean;
}

function parseArgs(rawArgs: Record<string, unknown>): ReadArgs {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.read: `path` must be a non-empty string");
  }
  const maxBytes =
    typeof rawArgs.maxBytes === "number" && Number.isFinite(rawArgs.maxBytes)
      ? Math.max(1, Math.floor(rawArgs.maxBytes))
      : DEFAULT_MAX_BYTES;
  const offset =
    typeof rawArgs.offset === "number" && Number.isFinite(rawArgs.offset)
      ? Math.trunc(rawArgs.offset)
      : undefined;
  const limit =
    typeof rawArgs.limit === "number" && Number.isFinite(rawArgs.limit)
      ? Math.max(0, Math.trunc(rawArgs.limit))
      : undefined;
  const lineNumbers = rawArgs.lineNumbers === true;
  return { path, maxBytes, offset, limit, lineNumbers };
}

export const osFsReadTool: ToolDefinition = {
  name: "os.fs.read",
  description:
    "Read a UTF-8 text file. Paths may be relative to the session working directory. Supports line-range reads via `offset` (1-indexed, negative counts from end) and `limit`, plus optional `LINE_NUMBER|` prefixes.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs);
    const absolute = resolveUserPath(args.path, ctx.workingDir);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`os.fs.read: ${absolute} is not a regular file`);
    }
    const canonical = await canonicalize(absolute);

    if (args.offset !== undefined || args.limit !== undefined) {
      return readByLines(absolute, canonical, info.size, args);
    }
    return readByBytes(absolute, canonical, info.size, args);
  },
};

/**
 * Symlink-resolved path, used only as the read-coverage identity so that
 * two reads of one file through different links are recognized as the
 * same file. `details.path` keeps the unresolved absolute path the caller
 * asked for — it is what the model and the UI have been shown all along,
 * and rewriting it here would change every read's output.
 *
 * A failure (a race deleting the file between `stat` and here, a
 * permission wall on a parent directory) degrades to the unresolved path:
 * a slightly coarser identity is strictly better than failing a read that
 * has already succeeded.
 */
async function canonicalize(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function readByBytes(
  absolute: string,
  canonical: string,
  size: number,
  args: ReadArgs,
): Promise<ReturnType<typeof compressToolResult>> {
  const handle = await open(absolute, "r");
  try {
    const toRead = Math.min(size, args.maxBytes);
    const buffer = Buffer.alloc(toRead);
    if (toRead > 0) {
      await handle.read(buffer, 0, toRead, 0);
    }
    const truncated = size > args.maxBytes;
    const body = buffer.toString("utf8");
    const text = args.lineNumbers ? prefixLineNumbers(body, 1) : body;
    // Byte mode returns the whole (possibly byte-capped) prefix, so the
    // returned range is lines 1..N of it. The top-level `startLine` /
    // `totalLines` details stay absent here — byte-mode results have
    // never carried them and consumers distinguish the two modes by
    // exactly that — so the span is reported only inside the coverage
    // detail, where it exists for the detector rather than for display.
    const lineCount = splitReadLines(body).length;
    return compressToolResult(
      {
        tool: "os.fs.read",
        status: "ok",
        output: text,
        details: {
          path: absolute,
          size,
          truncated,
          bytesRead: toRead,
          [READ_COVERAGE_DETAIL_KEY]: coverage(canonical, buffer, args, {
            startLine: lineCount === 0 ? 0 : 1,
            endLine: lineCount,
            totalLines: lineCount,
            truncated,
          }),
        },
      },
      { maxSummaryLength: args.maxBytes, maxTailLines: 500 },
    );
  } finally {
    await handle.close();
  }
}

async function readByLines(
  absolute: string,
  canonical: string,
  size: number,
  args: ReadArgs,
): Promise<ReturnType<typeof compressToolResult>> {
  const handle = await open(absolute, "r");
  let allLines: string[];
  let buffer: Buffer;
  try {
    const toRead = Math.min(size, args.maxBytes);
    buffer = Buffer.alloc(toRead);
    if (toRead > 0) {
      await handle.read(buffer, 0, toRead, 0);
    }
    allLines = splitReadLines(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }

  const total = allLines.length;
  const { startIndex, limit } = resolveRange(total, args.offset, args.limit);
  const sliced = allLines.slice(startIndex, startIndex + limit);
  const body = args.lineNumbers
    ? sliced
        .map((line, idx) => formatNumberedLine(startIndex + idx + 1, line))
        .join("\n")
    : sliced.join("\n");
  const readBytes = Math.min(size, args.maxBytes);
  const fileBytesTruncated = size > args.maxBytes;
  const linesTruncated = startIndex + sliced.length < total;
  return compressToolResult(
    {
      tool: "os.fs.read",
      status: "ok",
      output: body,
      details: {
        path: absolute,
        size,
        truncated: fileBytesTruncated || linesTruncated,
        bytesRead: readBytes,
        totalLines: total,
        startLine: total === 0 ? 0 : startIndex + 1,
        endLine: startIndex + sliced.length,
        returnedLines: sliced.length,
        // A read that returned nothing (empty file, or an offset past the
        // end) reports an empty 0/0 span rather than a range it did not
        // return — the detector must never credit coverage for lines the
        // model never saw.
        [READ_COVERAGE_DETAIL_KEY]: coverage(canonical, buffer, args, {
          startLine: sliced.length === 0 ? 0 : startIndex + 1,
          endLine: sliced.length === 0 ? 0 : startIndex + sliced.length,
          totalLines: total,
          // Deliberately NOT `truncated` from the details above: that one
          // also fires when the requested window merely ended before the
          // end of the readable prefix, which another offset can still
          // reach. The detector asks a narrower question — is there
          // content no range of this call could return? — and only the
          // byte cap makes that true.
          truncated: fileBytesTruncated,
        }),
      },
    },
    { maxSummaryLength: args.maxBytes, maxTailLines: 500 },
  );
}

/** Assemble the read-coverage detail for one successful read. */
function coverage(
  canonical: string,
  bytesRead: Buffer,
  args: ReadArgs,
  span: Pick<
    ReadCoverageDetail,
    "startLine" | "endLine" | "totalLines" | "truncated"
  >,
): ReadCoverageDetail {
  return {
    path: canonical,
    contentHash: hashReadContent(bytesRead),
    numbered: args.lineNumbers,
    ...span,
  };
}

function resolveRange(
  total: number,
  offset: number | undefined,
  limit: number | undefined,
): { startIndex: number; limit: number } {
  if (total === 0) return { startIndex: 0, limit: 0 };
  let startIndex: number;
  if (offset === undefined) {
    startIndex = 0;
  } else if (offset < 0) {
    // -1 = last line. clamp so that we never go below zero.
    startIndex = Math.max(0, total + offset);
  } else if (offset === 0) {
    startIndex = 0;
  } else {
    startIndex = Math.min(total, offset - 1);
  }
  const effectiveLimit =
    limit === undefined ? total - startIndex : Math.min(limit, total - startIndex);
  return { startIndex, limit: Math.max(0, effectiveLimit) };
}

function prefixLineNumbers(text: string, firstLineNumber: number): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line, idx) => formatNumberedLine(firstLineNumber + idx, line))
    .join("\n");
}

function formatNumberedLine(lineNumber: number, content: string): string {
  return `${String(lineNumber).padStart(6, " ")}|${content}`;
}
