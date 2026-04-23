import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createPatch, structuredPatch } from "diff";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Inputs for `os.fs.diff`. Either provide two paths (diff on disk) or two
 * inline strings (diff arbitrary snippets without touching the filesystem).
 * Path/string modes cannot be mixed within a single "side": if `aPath` is
 * set, `aText` is ignored, and vice versa.
 */
interface DiffArgs {
  aPath?: string;
  aText?: string;
  aLabel: string;
  bPath?: string;
  bText?: string;
  bLabel: string;
  context: number;
  ignoreWhitespace: boolean;
}

const DEFAULT_CONTEXT = 3;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export const osFsDiffTool: ToolDefinition = {
  name: "os.fs.diff",
  description:
    "Generate a git-style unified diff between two files (aPath vs bPath) or two inline strings (aText vs bText). Read-only. Use labels to customise the +++/--- headers.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs);
    const [aContent, bContent] = await Promise.all([
      resolveSide(args.aPath, args.aText, ctx.workingDir, "a"),
      resolveSide(args.bPath, args.bText, ctx.workingDir, "b"),
    ]);

    const patch = createPatch(
      args.aLabel,
      aContent,
      bContent,
      undefined,
      undefined,
      { context: args.context, ignoreWhitespace: args.ignoreWhitespace },
    );
    // `createPatch` only stamps `aLabel` into both headers. Rewrite the +++
    // header to use `bLabel` so consumers can tell the sides apart.
    const rewritten = rewriteHeaders(patch, args.aLabel, args.bLabel);

    const structured = structuredPatch(
      args.aLabel,
      args.bLabel,
      aContent,
      bContent,
      undefined,
      undefined,
      { context: args.context, ignoreWhitespace: args.ignoreWhitespace },
    );
    const stats = summariseHunks(structured.hunks);
    const identical = stats.added === 0 && stats.removed === 0;

    return compressToolResult(
      {
        tool: "os.fs.diff",
        status: "ok",
        output: identical ? "(files are identical)" : rewritten,
        details: {
          aLabel: args.aLabel,
          bLabel: args.bLabel,
          added: stats.added,
          removed: stats.removed,
          hunks: structured.hunks.length,
          identical,
        },
      },
      { maxSummaryLength: 64 * 1024, maxTailLines: 4000 },
    );
  },
};

function parseArgs(rawArgs: Record<string, unknown>): DiffArgs {
  const { aPath, aText } = parseSide(rawArgs.aPath, rawArgs.aText, "a");
  const { aPath: bPath, aText: bText } = parseSide(
    rawArgs.bPath,
    rawArgs.bText,
    "b",
  );
  const aLabel = parseLabel(rawArgs.aLabel, aPath, "a");
  const bLabel = parseLabel(rawArgs.bLabel, bPath, "b");
  const context = parsePositiveInt(rawArgs.context, DEFAULT_CONTEXT, "context");
  const ignoreWhitespace = rawArgs.ignoreWhitespace === true;
  return {
    aPath,
    aText,
    aLabel,
    bPath: bPath,
    bText: bText,
    bLabel,
    context,
    ignoreWhitespace,
  };
}

function parseSide(
  rawPath: unknown,
  rawText: unknown,
  side: string,
): { aPath?: string; aText?: string } {
  const hasPath = typeof rawPath === "string" && rawPath.length > 0;
  const hasText = typeof rawText === "string";
  if (!hasPath && !hasText) {
    throw new Error(
      `os.fs.diff: side ${side} requires either \`${side}Path\` or \`${side}Text\``,
    );
  }
  if (hasPath && hasText) {
    throw new Error(
      `os.fs.diff: side ${side} must not set both \`${side}Path\` and \`${side}Text\``,
    );
  }
  return hasPath
    ? { aPath: rawPath as string }
    : { aText: rawText as string };
}

function parseLabel(
  raw: unknown,
  path: string | undefined,
  side: string,
): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (path) return basename(path);
  return side;
}

function parsePositiveInt(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`os.fs.diff: \`${field}\` must be a non-negative number`);
  }
  return Math.floor(raw);
}

async function resolveSide(
  path: string | undefined,
  text: string | undefined,
  workingDir: string,
  side: string,
): Promise<string> {
  if (text !== undefined) {
    if (Buffer.byteLength(text, "utf8") > MAX_INLINE_BYTES) {
      throw new Error(
        `os.fs.diff: inline ${side}Text exceeds ${MAX_INLINE_BYTES} bytes`,
      );
    }
    return text;
  }
  const abs = resolveUserPath(path!, workingDir);
  const info = await stat(abs);
  if (!info.isFile()) {
    throw new Error(`os.fs.diff: ${abs} is not a regular file`);
  }
  if (info.size > MAX_INLINE_BYTES) {
    throw new Error(
      `os.fs.diff: ${abs} exceeds ${MAX_INLINE_BYTES} bytes; diff not supported for files this large`,
    );
  }
  return await readFile(abs, "utf8");
}

function rewriteHeaders(patch: string, _aLabel: string, bLabel: string): string {
  // `createPatch` emits lines like:
  //   Index: <aLabel>
  //   ===================================================================
  //   --- <aLabel>
  //   +++ <aLabel>     <- we want this to be bLabel instead
  //   @@ -...
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("+++ ")) {
      lines[i] = `+++ ${bLabel}`;
      break;
    }
  }
  return lines.join("\n");
}

interface Hunk {
  lines: string[];
}

function summariseHunks(hunks: readonly Hunk[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}
