import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "../fs/fs-require-approval.js";
import { buildPptx, type PptxImageInput } from "./pptx-build.js";
import { OS_FS_WRITE_PPTX_CONTRACT } from "./pptx-contract.js";
import { MAX_IMAGE_BYTES, sniffImage } from "./pptx-image.js";
import { parseDeckSpec, type PptxDeckSpec } from "./pptx-spec.js";

const TOOL = OS_FS_WRITE_PPTX_CONTRACT.name;

export type OsFsWritePptxOptions = Pick<
  FsDangerousToolOptions,
  "approvals" | "approvalRequired" | "trustConfigPaths"
>;

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

      const parts = [
        `${built.slideCount} slide${built.slideCount === 1 ? "" : "s"}`,
        `${built.notesCount} with speaker notes`,
        `${built.imageCount} picture${built.imageCount === 1 ? "" : "s"}`,
        `theme ${spec.theme}`,
      ];
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: `${exists ? "Replaced" : "Created"} ${absolute} (${parts.join(", ")}). Open it in PowerPoint, Keynote or LibreOffice to edit; read it back with os.fs.read_document.\n${outline(spec)}`,
        details: {
          path: absolute,
          slides: built.slideCount,
          notes: built.notesCount,
          images: built.imageCount,
          bytes: built.data.length,
          theme: spec.theme,
          replaced: exists,
        },
      });
    },
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
