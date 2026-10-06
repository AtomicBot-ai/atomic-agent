import { OS_FS_DIFF_CONTRACT, parseDiffArgs as parseArgs } from "./fs-diff-contract.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createPatch, structuredPatch } from "diff";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import type { ToolDefinition } from "../../tool-registry.js";
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export const osFsDiffTool: ToolDefinition = {
  name: OS_FS_DIFF_CONTRACT.name,
  description:
    OS_FS_DIFF_CONTRACT.description,
  readonly: OS_FS_DIFF_CONTRACT.readonly,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs, basename);
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

function rewriteHeaders(
  patch: string,
  _aLabel: string,
  bLabel: string,
): string {
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
