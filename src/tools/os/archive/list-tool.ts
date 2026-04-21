import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type { ArchiveEntry } from "./archive-types.js";
import {
  parseFormatOverride,
  resolveArchive,
  type ArchiveBackendFactories,
} from "./archive-resolver.js";

export interface ListArchiveToolOptions {
  backends?: ArchiveBackendFactories;
}

/**
 * `os.fs.archive.list` — enumerate archive contents without touching the
 * filesystem outside the source file. Returns a compact, LLM-friendly
 * listing (one entry per line) plus a structured `entries` array in the
 * details object so the model can decide what to extract next.
 */
export function buildOsFsArchiveListTool(
  options: ListArchiveToolOptions = {},
): ToolDefinition {
  return {
    name: "os.fs.archive.list",
    description:
      "List entries inside an archive (zip, tar, tar.gz/tgz, gz) without extracting. Read-only.",
    readonly: true,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("os.fs.archive.list: `path` must be a non-empty string");
      }
      const formatOverride = parseFormatOverride(rawArgs.format);
      const resolved = await resolveArchive(
        path,
        ctx.workingDir,
        formatOverride,
        options.backends,
      );
      const entries = await resolved.backend.list(resolved.data);
      const output = formatListing(entries);
      return compressToolResult(
        {
          tool: "os.fs.archive.list",
          status: "ok",
          output,
          details: {
            path: resolved.absolute,
            format: resolved.format,
            entryCount: entries.length,
            totalUncompressedBytes: totalSize(entries),
            entries: entries.map((e) => ({
              path: e.path,
              kind: e.kind,
              size: e.size,
              compressedSize: e.compressedSize,
              linkTarget: e.linkTarget,
            })),
          },
        },
        { maxSummaryLength: 64 * 1024, maxTailLines: 2000 },
      );
    },
  };
}

function formatListing(entries: readonly ArchiveEntry[]): string {
  if (entries.length === 0) return "(empty archive)";
  // Fixed-width columns so visually scanning the listing is easy. Size
  // column is right-aligned; `-` means unknown (tar gives no compressed
  // size, gz/archive streams may not report sizes either).
  const lines = entries.map((e) => {
    const size = e.size === undefined ? "-" : String(e.size);
    const kind = kindLetter(e.kind);
    const target = e.linkTarget ? ` -> ${e.linkTarget}` : "";
    return `${kind} ${size.padStart(10, " ")}  ${e.path}${target}`;
  });
  return lines.join("\n");
}

function kindLetter(kind: ArchiveEntry["kind"]): string {
  switch (kind) {
    case "file":
      return "-";
    case "directory":
      return "d";
    case "symlink":
      return "l";
  }
}

function totalSize(entries: readonly ArchiveEntry[]): number {
  let total = 0;
  for (const e of entries) {
    if (typeof e.size === "number") total += e.size;
  }
  return total;
}
