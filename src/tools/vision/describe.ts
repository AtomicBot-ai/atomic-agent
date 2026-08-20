import { compressToolResult } from "../../compressor/result-compressor.js";
import { VisionUnsupportedError, type LlmProvider } from "../../llm/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import { loadImageFile, UnsupportedImageFormatError } from "./load-image.js";

export interface VisionDescribeToolOptions {
  provider: LlmProvider;
  /** Per-call image count cap mirrored from `config.vision.maxImagesPerCall`. */
  maxImagesPerCall: number;
  /** Per-image byte cap mirrored from `config.vision.maxImageBytes`. */
  maxImageBytes: number;
}

interface ParsedArgs {
  paths: string[];
  prompt: string;
}

function parseArgs(rawArgs: Record<string, unknown>): ParsedArgs {
  const path = typeof rawArgs.path === "string" ? rawArgs.path : undefined;
  const pathsRaw = rawArgs.paths;
  const prompt = typeof rawArgs.prompt === "string" ? rawArgs.prompt.trim() : "";

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
    description:
      "Describe one or more images via the configured vision LLM. Use when the user attaches an image or asks what is on a screenshot.",
    readonly: true,
    async run(rawArgs, ctx) {
      let parsed: ParsedArgs;
      try {
        parsed = parseArgs(rawArgs);
      } catch (error) {
        return errorResult((error as Error).message);
      }
      if (parsed.paths.length > options.maxImagesPerCall) {
        return errorResult(
          `at most ${options.maxImagesPerCall} images per call (got ${parsed.paths.length})`,
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
          const loaded = await loadImageFile(parsed.paths[i]!, ctx.workingDir);
          if (loaded.bytes.byteLength > options.maxImageBytes) {
            return errorResult(
              `image ${loaded.path} exceeds maxImageBytes=${options.maxImageBytes}`,
            );
          }
          images.push({
            id: i + 1,
            bytes: loaded.bytes,
            mimeType: loaded.mimeType,
            path: loaded.path,
          });
        } catch (error) {
          if (error instanceof UnsupportedImageFormatError) {
            return errorResult(error.message);
          }
          return errorResult(`failed to load image: ${(error as Error).message}`);
        }
      }

      try {
        const result = await options.provider.describeImage({
          prompt: parsed.prompt,
          images: images.map(({ id, bytes, mimeType }) => ({ id, bytes, mimeType })),
          signal: ctx.signal,
        });
        return compressToolResult({
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
            })),
            durationMs: result.durationMs,
          },
        });
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
