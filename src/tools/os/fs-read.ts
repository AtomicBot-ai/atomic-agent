import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
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
    const absolute = isAbsolute(args.path)
      ? args.path
      : resolve(ctx.workingDir, args.path);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`os.fs.read: ${absolute} is not a regular file`);
    }

    if (args.offset !== undefined || args.limit !== undefined) {
      return readByLines(absolute, info.size, args);
    }
    return readByBytes(absolute, info.size, args);
  },
};

async function readByBytes(
  absolute: string,
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
  size: number,
  args: ReadArgs,
): Promise<ReturnType<typeof compressToolResult>> {
  const handle = await open(absolute, "r");
  let allLines: string[];
  try {
    const toRead = Math.min(size, args.maxBytes);
    const buffer = Buffer.alloc(toRead);
    if (toRead > 0) {
      await handle.read(buffer, 0, toRead, 0);
    }
    const text = buffer.toString("utf8");
    allLines = text.split(/\r?\n/);
    // A trailing newline produces an empty final element; drop it so the
    // caller's line numbers align with typical editor line counts.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
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
      },
    },
    { maxSummaryLength: args.maxBytes, maxTailLines: 500 },
  );
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
