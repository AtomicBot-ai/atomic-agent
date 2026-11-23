import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import type { FsDangerousToolOptions } from "../fs/fs-require-approval.js";
import { MAX_IMAGE_BYTES, sniffImage } from "../pptx/pptx-image.js";
import { REVISION_AUTHOR, type DocImageInput, type Revision } from "./docx-blocks.js";
import { appendToDocx, createDocx } from "./docx-package.js";
import { replaceInDocx } from "./docx-replace.js";
import { parseBlocks, type DocBlock } from "./docx-xml.js";
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
  /** Write the edit as Word tracked changes by "Atomic Agent" (append, replace). */
  track: boolean;
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
  const track = raw.track === true;
  if (track && op === "create") {
    throw new Error(`${TOOL}: track applies to append and replace (a new document has nothing to compare against)`);
  }
  return {
    path,
    op,
    blocks,
    ...(find === undefined ? {} : { find }),
    replaceWith,
    all: raw.all !== false,
    overwrite: raw.overwrite === true,
    track,
  };
}

/** Read and check every picture the blocks embed, before anything is asked. */
async function loadImages(blocks: readonly DocBlock[], workingDir: string): Promise<Map<string, DocImageInput>> {
  const images = new Map<string, DocImageInput>();
  for (const block of blocks) {
    if (block.kind !== "image" || block.path === undefined || images.has(block.path)) continue;
    const path = resolveUserPath(block.path, workingDir);
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      throw new Error(`${TOOL}: no picture at ${block.path}`);
    }
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`${TOOL}: ${block.path} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
    }
    const data = await readFile(path);
    const info = sniffImage(data);
    if (info === null) {
      throw new Error(`${TOOL}: ${block.path} is not a PNG, JPEG or GIF picture (convert it first)`);
    }
    images.set(block.path, { data, info, name: basename(path) });
  }
  return images;
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
      let blocks: DocBlock[];
      try {
        blocks = parseBlocks(args.blocks);
      } catch (err) {
        throw new Error(`${TOOL}: ${(err as Error).message}`);
      }
      const images = await loadImages(blocks, ctx.workingDir);
      // One author and time for the whole edit, the way Word stamps a save.
      const now = new Date();
      const revision = (): Revision | undefined =>
        args.track ? { author: REVISION_AUTHOR, date: now, nextId: 1 } : undefined;
      const trackNote = args.track ? ` as tracked changes by ${REVISION_AUTHOR}` : "";

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
            data: await createDocx(blocks, { images }),
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
            data: await wrapDocxError(() => {
              const rev = revision();
              return appendToDocx(current, blocks, { images, ...(rev === undefined ? {} : { revision: rev }) });
            }, absolute),
            reason: `append ${blocks.length} paragraphs to ${absolute}${trackNote}`,
            done: `appended ${blocks.length} paragraphs to ${absolute}${trackNote}`,
            details: { paragraphs: blocks.length, ...(args.track ? { tracked: true } : {}) },
          };
        }
        const find = args.find ?? "";
        const outcome = await wrapDocxError(
          () => {
            const rev = revision();
            return replaceInDocx(current, find, args.replaceWith, {
              all: args.all,
              ...(rev === undefined ? {} : { revision: rev }),
            });
          },
          absolute,
        );
        if (outcome.count === 0) {
          throw new Error(
            `${TOOL}: ${JSON.stringify(find)} was not found in ${absolute}. Matching is exact and case-sensitive within one paragraph; read the text with os.fs.read_document first`,
          );
        }
        return {
          data: outcome.data,
          reason: `replace ${outcome.count} × ${JSON.stringify(find)} in ${absolute}${trackNote}`,
          done: `replaced ${outcome.count} occurrence${outcome.count === 1 ? "" : "s"} of ${JSON.stringify(find)} in ${absolute}${trackNote}`,
          details: { replacements: outcome.count, parts: outcome.parts, ...(args.track ? { tracked: true } : {}) },
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
