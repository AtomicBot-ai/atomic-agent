import { extname } from "node:path";

import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import type { FsDangerousToolOptions } from "../fs/fs-require-approval.js";
import { appendToDocx, createDocx } from "./docx-package.js";
import { replaceInDocx } from "./docx-replace.js";
import { parseBlocks } from "./docx-xml.js";
import { OS_FS_DOCX_CONTRACT } from "./office-contracts.js";
import { commitOfficeFile, given, optionalString, readExisting } from "./office-write.js";

const TOOL = OS_FS_DOCX_CONTRACT.name;

/** One call's worth of paragraphs: a whole report, not an unbounded dump. */
export const MAX_DOCX_BLOCKS = 2000;

type DocxOp = "create" | "append" | "replace";

interface DocxArgs {
  path: string;
  op: DocxOp;
  blocks: string[];
  find?: string;
  replaceWith: string;
  all: boolean;
  overwrite: boolean;
}

export function parseDocxArgs(raw: Record<string, unknown>): DocxArgs {
  const path = raw.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${TOOL}: \`path\` must be a non-empty string`);
  }
  if (extname(path).toLowerCase() !== ".docx") {
    throw new Error(`${TOOL}: \`path\` must end in .docx (got ${JSON.stringify(path)}); for .xlsx use os.fs.xlsx`);
  }
  const op = raw.op;
  if (op !== "create" && op !== "append" && op !== "replace") {
    throw new Error(`${TOOL}: \`op\` must be one of create, append, replace`);
  }
  let blocks: string[] = [];
  if (given(raw.blocks)) {
    if (!Array.isArray(raw.blocks) || !raw.blocks.every((b) => typeof b === "string")) {
      throw new Error(`${TOOL}: \`blocks\` must be an array of strings (one paragraph each)`);
    }
    blocks = raw.blocks as string[];
  }
  if (blocks.length > MAX_DOCX_BLOCKS) {
    throw new Error(`${TOOL}: at most ${MAX_DOCX_BLOCKS} blocks per call (got ${blocks.length})`);
  }
  if (op === "append" && blocks.length === 0) {
    throw new Error(`${TOOL}: append needs a non-empty \`blocks\` array`);
  }
  const find = optionalString(raw.find, "find", TOOL);
  if (op === "replace" && find === undefined) {
    throw new Error(`${TOOL}: replace needs a non-empty \`find\``);
  }
  // An empty replacement is a real request (delete the text), so only
  // null or a missing field fall back to it.
  const replaceWith = typeof raw.replaceWith === "string" ? raw.replaceWith : "";
  return {
    path,
    op,
    blocks,
    ...(find === undefined ? {} : { find }),
    replaceWith,
    all: raw.all !== false,
    overwrite: raw.overwrite === true,
  };
}

export function buildOsFsDocxTool(options: FsDangerousToolOptions): ToolDefinition {
  return {
    name: TOOL,
    description: OS_FS_DOCX_CONTRACT.description,
    readonly: OS_FS_DOCX_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseDocxArgs(rawArgs);
      const absolute = resolveUserPath(args.path, ctx.workingDir);
      const existing = await readExisting(absolute, TOOL);
      const blocks = parseBlocks(args.blocks);

      // Built twice when the file changes under the approval prompt: once
      // from the bytes read now (for the card), again from the bytes on
      // disk after the answer, so a save made meanwhile is kept.
      const build = async (current: Buffer | null): Promise<DocxEdit> => {
        if (args.op === "create") {
          if (current !== null && !args.overwrite) {
            throw new Error(
              `${TOOL}: ${absolute} already exists; use op append or replace to edit it, or overwrite: true to replace it`,
            );
          }
          return {
            data: await createDocx(blocks),
            reason: `${current === null ? "create" : "replace"} Word document ${absolute} (${blocks.length} paragraphs)`,
            done: `${current === null ? "created" : "replaced"} ${absolute} with ${blocks.length} paragraphs`,
            details: { paragraphs: blocks.length },
          };
        }
        if (current === null) {
          throw new Error(`${TOOL}: ${absolute} does not exist; use op create to make it`);
        }
        if (args.op === "append") {
          return {
            data: await wrapDocxError(() => appendToDocx(current, blocks), absolute),
            reason: `append ${blocks.length} paragraphs to ${absolute}`,
            done: `appended ${blocks.length} paragraphs to ${absolute}`,
            details: { paragraphs: blocks.length },
          };
        }
        const find = args.find ?? "";
        const outcome = await wrapDocxError(
          () => replaceInDocx(current, find, args.replaceWith, { all: args.all }),
          absolute,
        );
        if (outcome.count === 0) {
          throw new Error(
            `${TOOL}: ${JSON.stringify(find)} was not found in ${absolute}. Matching is exact and case-sensitive within one paragraph; read the text with os.fs.read_document first`,
          );
        }
        return {
          data: outcome.data,
          reason: `replace ${outcome.count} × ${JSON.stringify(find)} in ${absolute}`,
          done: `replaced ${outcome.count} occurrence${outcome.count === 1 ? "" : "s"} of ${JSON.stringify(find)} in ${absolute}`,
          details: { replacements: outcome.count, parts: outcome.parts },
        };
      };
      let edit = await build(existing);

      const preview =
        args.op === "replace"
          ? `${JSON.stringify(args.find)} → ${JSON.stringify(args.replaceWith)}`
          : args.blocks.join("\n").slice(0, 400);
      const result = await commitOfficeFile(options, ctx, {
        tool: TOOL,
        absolute,
        display: args.path,
        data: edit.data,
        baseline: existing,
        rebuild: async (fresh) => {
          if (args.op === "create" && existing === null && fresh !== null) {
            // The card offered a new file; replacing one is a different question.
            throw new Error(`${TOOL}: ${absolute} appeared meanwhile; ask again to replace it`);
          }
          edit = await build(fresh);
          return edit.data;
        },
        reason: edit.reason,
        preview,
        replacesWhole: args.op === "create" && existing !== null,
      });
      const details: Record<string, unknown> = { path: absolute, op: args.op, ...edit.details };
      if (result.rebuilt) details.rebuiltAfterApproval = true;
      const done = edit.done;
      const data = result.data;
      details.bytes = data.byteLength;
      const output = result.restoreNote === null ? done : `${done}; ${result.restoreNote}`;
      return compressToolResult({ tool: TOOL, status: "ok", output, details });
    },
  };
}

interface DocxEdit {
  data: Buffer;
  reason: string;
  done: string;
  details: Record<string, unknown>;
}

async function wrapDocxError<T>(work: () => Promise<T>, absolute: string): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new Error(`${TOOL}: could not edit ${absolute}: ${(err as Error).message}`);
  }
}
