import { compressToolResult } from "../../compressor/result-compressor.js";
import { VisionUnsupportedError, type LlmProvider } from "../../llm/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  ImageTooLargeError,
  loadImageFile,
  NotARegularFileError,
  UnsupportedImageFormatError,
} from "./load-image.js";

/**
 * Per-call compressor bounds for a successful `vision.describe`.
 *
 * The VLM's answer is free-form prose, routinely several paragraphs
 * (a screenshot walkthrough, an OCR transcript). Under the
 * runtime-wide defaults it was cut twice: `maxTailLines: 12` keeps
 * only the LAST twelve non-blank lines and `maxSummaryLength: 400`
 * then slices the head of the remainder, so a 2 KB description
 * reached the model as ~385 chars of its ending — the opening
 * sentence, which is where a describe answer states what the image
 * is, was the first thing thrown away. Nothing can recover it: the
 * conversation turn keeps only `summary`, `details` holds just
 * provider/paths/bytes, and a re-run costs another paid,
 * non-deterministic model call that would be cut the same way.
 *
 * Budget — what the tool can PRODUCE and what the prompt can DELIVER
 * are different numbers, and the smaller one wins. Produce:
 * `describeImage` caps generation at `max_tokens: 4096` on the
 * OpenAI path (`llm/provider/openai/openai-describe-image.ts`) and
 * 512 on llama-server
 * (`llm/provider/llama-server/llama-server-vision.ts`), so ~16 KB at
 * ~4 chars/token. Deliver: `TOOL_RESULT_RENDER_CAP_CHARS` in
 * `session/conversation-turn.ts` clips every rendered tool_result to
 * 8_000 chars, and `vision.describe` is not in the
 * `TOOLS_FULL_BODY_WHEN_FRESH` bypass set — not even on the
 * inference that consumes the result. Keeping more than 8_000 would
 * only store text the renderer cuts again every turn, so the cap is
 * aligned to the render ceiling, as `MCP_COMPRESSOR_OPTIONS` in
 * `mcp/mcp-tool-adapter.ts` already is. A typical description is
 * 500-3000 chars and is unaffected; if `vision.describe` ever joins
 * the bypass set, this should go back up to ~16_000.
 *
 * Tail truncation is disabled because prose is a document, not a
 * log. Caveat inherited from the compressor: `extractTail` drops
 * blank lines unconditionally, so a multi-paragraph description
 * arrives with its paragraph breaks collapsed — every sentence
 * survives, the blank lines between them do not.
 */
const VISION_COMPRESSOR_OPTIONS = {
  maxSummaryLength: 8_000,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

export interface VisionDescribeToolOptions {
  provider: LlmProvider;
  /** Per-call image count cap mirrored from `config.vision.maxImagesPerCall`. */
  maxImagesPerCall: number;
  /** Per-image byte cap mirrored from `config.vision.maxImageBytes`. */
  maxImageBytes: number;
  /**
   * Optional — `loadImageFile` warns through it when a file's extension
   * contradicts its bytes. Absent in tests that do not care.
   */
  logger?: StructuredLogger | undefined;
}

interface ParsedArgs {
  paths: string[];
  prompt: string;
}

function parseArgs(rawArgs: Record<string, unknown>): ParsedArgs {
  const path = typeof rawArgs.path === "string" ? rawArgs.path : undefined;
  const pathsRaw = rawArgs.paths;
  const prompt =
    typeof rawArgs.prompt === "string" ? rawArgs.prompt.trim() : "";

  let paths: string[] = [];
  if (path) paths.push(path);
  if (Array.isArray(pathsRaw)) {
    for (const entry of pathsRaw) {
      if (typeof entry === "string" && entry.length > 0) paths.push(entry);
    }
  }
  if (paths.length === 0) {
    throw new Error(
      "vision.describe: provide either `path: string` or `paths: string[]`",
    );
  }
  if (prompt.length === 0) {
    throw new Error("vision.describe: `prompt` must be a non-empty string");
  }
  return { paths, prompt };
}

/**
 * `vision.describe { path | paths, prompt }` — load one or more
 * images from the session working directory and ask the configured
 * LLM provider to describe them. Always returns a compact summary
 * inside `CompressedToolResult` so the agent loop renders it in
 * `### latest-result` like any other tool, without disturbing the
 * stable prefix or the conversation transcript schema.
 *
 * The provider runs the call on `slotId: -1` (no KV-cache reuse),
 * so the main agent's slot and the reflection slot stay pristine.
 */
export function buildVisionDescribeTool(
  options: VisionDescribeToolOptions,
): ToolDefinition {
  return {
    name: "vision.describe",
    description: `Describe one or more images via the configured vision LLM. Use when the user attaches an image or asks what is on a screenshot. At most ${options.maxImagesPerCall} images per call; to cover more, split them across several calls.`,
    readonly: true,
    async run(rawArgs, ctx) {
      let parsed: ParsedArgs;
      try {
        parsed = parseArgs(rawArgs);
      } catch (error) {
        return errorResult((error as Error).message);
      }
      if (parsed.paths.length > options.maxImagesPerCall) {
        const calls = Math.ceil(parsed.paths.length / options.maxImagesPerCall);
        return errorResult(
          `at most ${options.maxImagesPerCall} images per call (got ${parsed.paths.length})` +
            ` — split into ${calls} calls of at most ${options.maxImagesPerCall}`,
        );
      }
      if (!options.provider.capabilities.vision) {
        return errorResult(
          `vision is not available on the active provider (${options.provider.capabilities.visionSource})`,
        );
      }

      const images = [];
      for (let i = 0; i < parsed.paths.length; i += 1) {
        try {
          const loaded = await loadImageFile(parsed.paths[i]!, ctx.workingDir, {
            logger: options.logger,
            maxBytes: options.maxImageBytes,
          });
          // `maxBytes` already rejected an over-cap file from its `stat`;
          // this covers the one case that cannot: a file that grew
          // between the stat and the read.
          if (loaded.bytes.byteLength > options.maxImageBytes) {
            return errorResult(
              `image ${loaded.path} exceeds maxImageBytes=${options.maxImageBytes}`,
            );
          }
          images.push({
            id: i + 1,
            bytes: loaded.bytes,
            mimeType: loaded.mimeType,
            mimeTypeSource: loaded.mimeTypeSource,
            path: loaded.path,
          });
        } catch (error) {
          if (
            error instanceof UnsupportedImageFormatError ||
            error instanceof ImageTooLargeError ||
            error instanceof NotARegularFileError
          ) {
            return errorResult(error.message);
          }
          return errorResult(
            `failed to load image: ${(error as Error).message}`,
          );
        }
      }

      try {
        const result = await options.provider.describeImage({
          prompt: parsed.prompt,
          images: images.map(({ id, bytes, mimeType }) => ({
            id,
            bytes,
            mimeType,
          })),
          signal: ctx.signal,
        });
        return compressToolResult(
          {
            tool: "vision.describe",
            status: "ok",
            output: result.text,
            details: {
              provider: options.provider.name,
              images: images.map((img) => ({
                id: img.id,
                path: img.path,
                bytes: img.bytes.byteLength,
                mimeType: img.mimeType,
                mimeTypeSource: img.mimeTypeSource,
              })),
              durationMs: result.durationMs,
            },
          },
          VISION_COMPRESSOR_OPTIONS,
        );
      } catch (error) {
        if (error instanceof VisionUnsupportedError) {
          return errorResult(error.message);
        }
        return errorResult(`vision call failed: ${(error as Error).message}`);
      }
    },
  };
}

function errorResult(message: string) {
  return compressToolResult({
    tool: "vision.describe",
    status: "error",
    output: message,
  });
}
