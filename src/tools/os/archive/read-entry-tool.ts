import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  parseFormatOverride,
  resolveArchive,
  type ArchiveBackendFactories,
} from "./archive-resolver.js";

const DEFAULT_MAX_BYTES = 256 * 1024;

export interface ReadEntryToolOptions {
  backends?: ArchiveBackendFactories;
}

/**
 * `os.fs.archive.read_entry` — extract a single entry's body straight to
 * the tool result without materialising anything on disk.
 *
 * `as` selects the output encoding:
 *   - "utf8"   (default) — returns the body as UTF-8 text. If the bytes
 *                          don't decode cleanly, caller gets a warning and
 *                          falls back to base64.
 *   - "base64"            — always base64, suitable for binary entries.
 */
export function buildOsFsArchiveReadEntryTool(
  options: ReadEntryToolOptions = {},
): ToolDefinition {
  return {
    name: "os.fs.archive.read_entry",
    description:
      "Read a single entry from an archive without extracting to disk. Returns the body as UTF-8 text (default) or base64. Read-only.",
    readonly: true,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      const entry = rawArgs.entry;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(
          "os.fs.archive.read_entry: `path` must be a non-empty string",
        );
      }
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(
          "os.fs.archive.read_entry: `entry` must be a non-empty string",
        );
      }
      const as = parseAs(rawArgs.as);
      const maxBytes = parseMaxBytes(rawArgs.maxBytes);
      const formatOverride = parseFormatOverride(rawArgs.format);

      const resolved = await resolveArchive(
        path,
        ctx.workingDir,
        formatOverride,
        options.backends,
      );
      const body = await resolved.backend.readEntry(resolved.data, entry);
      const truncated = body.length > maxBytes;
      const trimmed = truncated ? body.subarray(0, maxBytes) : body;

      const { text, encoding, warning } = encodeBody(trimmed, as);
      const details: Record<string, unknown> = {
        path: resolved.absolute,
        entry,
        format: resolved.format,
        bytes: body.length,
        truncated,
        encoding,
      };
      if (warning) details.warning = warning;

      return compressToolResult(
        {
          tool: "os.fs.archive.read_entry",
          status: "ok",
          output: text,
          details,
        },
        { maxSummaryLength: maxBytes, maxTailLines: 5000 },
      );
    },
  };
}

function parseAs(raw: unknown): "utf8" | "base64" {
  if (raw === undefined || raw === null) return "utf8";
  if (raw === "utf8" || raw === "base64") return raw;
  throw new Error(
    "os.fs.archive.read_entry: `as` must be 'utf8' or 'base64'",
  );
}

function parseMaxBytes(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_BYTES;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      "os.fs.archive.read_entry: `maxBytes` must be a positive number",
    );
  }
  return Math.floor(raw);
}

function encodeBody(
  data: Buffer,
  mode: "utf8" | "base64",
): { text: string; encoding: "utf8" | "base64"; warning?: string } {
  if (mode === "base64") {
    return { text: data.toString("base64"), encoding: "base64" };
  }
  // Detect obviously-binary payloads cheaply: NUL byte anywhere in the
  // first 4 KB is a near-certain signal. We fall back to base64 in that
  // case so the LLM receives something sensible instead of a mangled UTF-8
  // blob.
  const probe = data.subarray(0, Math.min(data.length, 4096));
  const hasNul = probe.includes(0);
  if (hasNul) {
    return {
      text: data.toString("base64"),
      encoding: "base64",
      warning: "entry contains NUL bytes; returned as base64",
    };
  }
  return { text: data.toString("utf8"), encoding: "utf8" };
}
