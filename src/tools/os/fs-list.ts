import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";

const DEFAULT_MAX_ENTRIES = 200;

export const osFsListTool: ToolDefinition = {
  name: "os.fs.list",
  description:
    "List entries in a directory. Returns name, kind (file|dir|other), and size.",
  readonly: true,
  async run(rawArgs, ctx) {
    const path = rawArgs.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("os.fs.list: `path` must be a non-empty string");
    }
    const maxEntries =
      typeof rawArgs.maxEntries === "number" &&
      Number.isFinite(rawArgs.maxEntries)
        ? Math.max(1, Math.floor(rawArgs.maxEntries))
        : DEFAULT_MAX_ENTRIES;
    const absolute = resolveUserPath(path, ctx.workingDir);
    const entries = await readdir(absolute);
    const sliced = entries.slice(0, maxEntries);
    const rows: Array<{
      name: string;
      kind: "file" | "dir" | "other";
      size: number;
    }> = [];
    for (const name of sliced) {
      try {
        const info = await stat(join(absolute, name));
        const kind: "file" | "dir" | "other" = info.isFile()
          ? "file"
          : info.isDirectory()
            ? "dir"
            : "other";
        rows.push({ name, kind, size: info.size });
      } catch {
        rows.push({ name, kind: "other", size: 0 });
      }
    }
    const text = rows
      .map((row) => `${row.kind.padEnd(4)} ${row.size.toString().padStart(8)}  ${row.name}`)
      .join("\n");
    const footer =
      entries.length > sliced.length
        ? `\n… [omitted ${entries.length - sliced.length} more entries]`
        : "";
    return compressToolResult(
      {
        tool: "os.fs.list",
        status: "ok",
        output: text + footer,
        details: {
          path: absolute,
          total: entries.length,
          shown: rows.length,
          entries: rows,
        },
      },
      { maxSummaryLength: 4000, maxTailLines: 500 },
    );
  },
};
