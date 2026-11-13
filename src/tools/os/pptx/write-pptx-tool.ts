import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import {
  checkInputReplacement,
  refuseInputReplacement,
} from "../fs/fs-input-guard.js";
import {
  formatBytes,
  readPriorFile,
  type PriorFile,
} from "../fs/fs-replace-guard.js";
import { RESTORE_MAX_BYTES, type FileRestoreStore } from "../fs/fs-restore-store.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "../fs/fs-require-approval.js";
import { buildPptx, type PptxImageInput } from "./pptx-build.js";
import { OS_FS_WRITE_PPTX_CONTRACT } from "./pptx-contract.js";
import { MAX_IMAGE_BYTES, sniffImage } from "./pptx-image.js";
import { parseDeckSpec, type PptxDeckSpec } from "./pptx-spec.js";

const TOOL = OS_FS_WRITE_PPTX_CONTRACT.name;

/**
 * The same option bag `os.fs.write` gets (`fsMutation` in
 * `registerOsTools`): the restore store, the turn's request and the
 * fan-out's declared inputs decide whether an existing deck may be
 * replaced and keep a copy of it when it is.
 */
export type OsFsWritePptxOptions = FsDangerousToolOptions;

/**
 * `os.fs.write_pptx`: a deck from a slide list, written in-process
 * (JSZip, no Python, no pandoc). Everything that can fail — the spec,
 * each picture, an existing target — fails before the operator is
 * asked, so an approval is never spent on a write that cannot happen.
 * The write itself rides the same approval funnel as `os.fs.write`.
 */
export function buildOsFsWritePptxTool(options: OsFsWritePptxOptions): ToolDefinition {
  return {
    name: TOOL,
    description: OS_FS_WRITE_PPTX_CONTRACT.description,
    readonly: OS_FS_WRITE_PPTX_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const spec = parseDeckSpec(rawArgs);
      const absolute = resolveUserPath(spec.path, ctx.workingDir);
      const exists = await targetExists(absolute);
      if (exists && !spec.overwrite) {
        throw new Error(
          `${TOOL}: ${spec.path} already exists; pass overwrite: true to replace it, or pick another path`,
        );
      }
      // A deck the request names as an input (or a fan-out declared) is
      // not replaced, whatever `overwrite` says: the same rule, and the
      // same refusal, as `os.fs.write` (F51, ATO-851). Decided before the
      // operator is asked, so no prompt is raised for a write that will
      // not run.
      const prior = exists ? binaryPrior(await readPriorFile(absolute)) : null;
      if (prior !== null) {
        const refused = await checkInputReplacement({
          store: options.restore,
          sessionId: ctx.sessionId,
          absolute,
          display: spec.path,
          prior,
          after: "",
          request: options.resolveOriginalRequest?.(ctx.sessionId),
          previousReply: options.resolvePreviousReply?.(ctx.sessionId),
          declaredInputs: options.declaredInputs?.inputsOf(ctx.sessionId),
          overwrite: spec.overwrite,
        });
        if (refused !== null) return refuseInputReplacement(TOOL, refused);
      }
      const images = await loadImages(spec, ctx.workingDir);
      const built = await buildPptx({ spec, images });

      await requireFsApproval(
        options,
        {
          kind: "write",
          paths: [absolute],
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `${exists ? "replace" : "create"} a ${built.slideCount}-slide PowerPoint deck at ${absolute}`,
          preview: outline(spec),
          affectedResources: [absolute],
          // Replacing a deck is a whole-file replace: a no to it holds
          // for the rest of the turn, like `os.fs.write`'s.
          targetPaths: exists ? [absolute] : [],
          workingDir: ctx.workingDir,
          ...(options.trustConfigPaths === undefined
            ? {}
            : { trustConfigPaths: options.trustConfigPaths }),
        },
        ctx.signal,
      );

      // What is there now, read after the prompt (the user may have saved
      // the deck while it was open): the bytes the restore copy keeps.
      const replacing = exists ? binaryPrior(await readPriorFile(absolute)) : null;
      await mkdir(dirname(absolute), { recursive: true });
      // Written beside the target and renamed into place, so a reader
      // (or a crash) never sees half a zip under the real name.
      const temp = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.tmp`);
      try {
        await writeFile(temp, built.data);
        await rename(temp, absolute);
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
      const restoreNote =
        replacing === null
          ? await noteCreated(options.restore, ctx.sessionId, absolute)
          : await saveRestoreCopy(options.restore, {
              sessionId: ctx.sessionId,
              workingDir: ctx.workingDir,
              absolute,
              display: spec.path,
              prior: replacing,
            });

      const parts = [
        `${built.slideCount} slide${built.slideCount === 1 ? "" : "s"}`,
        `${built.notesCount} with speaker notes`,
        `${built.imageCount} picture${built.imageCount === 1 ? "" : "s"}`,
        `theme ${spec.theme}`,
      ];
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: `${restoreNote === null ? "" : `${restoreNote.note}\n`}${exists ? "Replaced" : "Created"} ${absolute} (${parts.join(", ")}). Open it in PowerPoint, Keynote or LibreOffice to edit; read it back with os.fs.read_document.\n${outline(spec)}`,
        details: {
          path: absolute,
          slides: built.slideCount,
          notes: built.notesCount,
          images: built.imageCount,
          bytes: built.data.length,
          theme: spec.theme,
          replaced: exists,
          ...(restoreNote === null ? {} : { restoreCopy: restoreNote.saved }),
        },
      });
    },
  };
}

/**
 * A deck is a zip, so its "lines" mean nothing: the counts in a refusal
 * or a note are bytes (`31.2 KB → …`), the way a file too large to read
 * is reported.
 */
function binaryPrior(prior: PriorFile | null): PriorFile | null {
  return prior === null ? null : { ...prior, lines: null, firstLine: null };
}

/** Remember that this session created the deck, so replacing it later is not a loss. Best effort. */
async function noteCreated(
  store: FileRestoreStore | undefined,
  sessionId: string,
  absolute: string,
): Promise<null> {
  if (store !== undefined) {
    try {
      await store.recordCreated(sessionId, absolute);
    } catch {
      // The deck already landed; a missing manifest entry only means a
      // later replacement keeps a copy it did not need.
    }
  }
  return null;
}

/**
 * Keep the replaced deck's previous bytes in the restore store, as
 * `os.fs.write` does for a user's file (`guardReplacedFile`), so
 * `os.fs.restore` brings it back. Not for a deck this session created,
 * an empty file, or without a store. Returns the line the result leads
 * with and whether the copy was kept, or null when nothing is claimed.
 */
async function saveRestoreCopy(
  store: FileRestoreStore | undefined,
  input: {
    sessionId: string;
    workingDir: string;
    absolute: string;
    display: string;
    prior: PriorFile;
  },
): Promise<{ note: string; saved: boolean } | null> {
  const { prior } = input;
  if (store === undefined || prior.bytes === 0) return null;
  if (await store.wasCreated(input.sessionId, input.absolute)) return null;
  const head = `replaced the user's file \`${input.display}\` (${formatBytes(prior.bytes)})`;
  if (prior.content === null || prior.bytes > RESTORE_MAX_BYTES) {
    return {
      note: `⚠ ${head}; the previous content was too large to save (over ${formatBytes(RESTORE_MAX_BYTES)})`,
      saved: false,
    };
  }
  try {
    await store.saveCopy(input.workingDir, input.absolute, prior.content, {
      tool: TOOL,
      lines: 0,
      sessionId: input.sessionId,
    });
  } catch (err) {
    return {
      note: `⚠ ${head}; the previous content could not be saved: ${(err as Error).message}`,
      saved: false,
    };
  }
  return {
    note: `${head}; the previous content is saved — \`os.fs.restore ${JSON.stringify({ path: input.display })}\` brings it back`,
    saved: true,
  };
}

async function targetExists(absolute: string): Promise<boolean> {
  try {
    const info = await stat(absolute);
    if (info.isDirectory()) {
      throw new Error(`${TOOL}: ${absolute} is a folder; give a file path ending in .pptx`);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function loadImages(
  spec: PptxDeckSpec,
  workingDir: string,
): Promise<Map<number, PptxImageInput>> {
  const images = new Map<number, PptxImageInput>();
  for (const [index, slide] of spec.slides.entries()) {
    if (slide.image === undefined) continue;
    const where = `slides[${index}].image`;
    const path = resolveUserPath(slide.image, workingDir);
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      throw new Error(`${TOOL}: ${where}: no picture at ${slide.image}`);
    }
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(
        `${TOOL}: ${where}: ${slide.image} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`,
      );
    }
    const data = await readFile(path);
    const info = sniffImage(data);
    if (info === null) {
      throw new Error(
        `${TOOL}: ${where}: ${slide.image} is not a PNG, JPEG or GIF picture (convert it first)`,
      );
    }
    images.set(index, { data, info, name: basename(path) });
  }
  return images;
}

/** The deck as the operator sees it in the approval prompt and the model in the result. */
function outline(spec: PptxDeckSpec): string {
  const lines = spec.slides.map((slide, i) => {
    const extras = [
      slide.bullets.length > 0 ? `${slide.bullets.length} bullets` : "",
      slide.image !== undefined ? "picture" : "",
      slide.notes !== undefined ? "notes" : "",
    ].filter((part) => part.length > 0);
    return `${i + 1}. ${slide.title}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
  });
  const shown = lines.slice(0, 30);
  if (lines.length > shown.length) shown.push(`… and ${lines.length - shown.length} more`);
  return shown.join("\n");
}
