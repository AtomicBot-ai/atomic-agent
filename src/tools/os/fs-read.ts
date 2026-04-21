import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

export const osFsReadTool: ToolDefinition = {
  name: "os.fs.read",
  description:
    "Read a UTF-8 text file. Paths may be relative to the session working directory.",
  readonly: true,
  async run(rawArgs, ctx) {
    const path = rawArgs.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("os.fs.read: `path` must be a non-empty string");
    }
    const maxBytes =
      typeof rawArgs.maxBytes === "number" && Number.isFinite(rawArgs.maxBytes)
        ? Math.max(1, Math.floor(rawArgs.maxBytes))
        : DEFAULT_MAX_BYTES;
    const absolute = isAbsolute(path) ? path : resolve(ctx.workingDir, path);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`os.fs.read: ${absolute} is not a regular file`);
    }
    const truncated = info.size > maxBytes;
    const buffer = await readFile(absolute);
    const text = buffer.slice(0, maxBytes).toString("utf8");
    return compressToolResult(
      {
        tool: "os.fs.read",
        status: "ok",
        output: text,
        details: {
          path: absolute,
          size: info.size,
          truncated,
        },
      },
      { maxSummaryLength: maxBytes, maxTailLines: 500 },
    );
  },
};
