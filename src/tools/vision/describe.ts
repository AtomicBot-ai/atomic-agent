import {
  compressToolResult,
  type CompressorOptions,
} from "../../compressor/result-compressor.js";
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

/**
 * Where the tool finds its provider. A fixed provider, or a lookup run
 * on EVERY call with the step's pinned provider id
 * (`ToolContext.providerId`, set on a fusion worker's steps) — the
 * runtime passes the lookup so the tool follows provider switches and
 * the fusion legs without a restart (`src/runtime/vision-route.ts`).
 * `undefined` from the lookup means nothing can serve this step.
 */
export type VisionProviderSource =
  | LlmProvider
  | ((providerId: string | undefined) => LlmProvider | undefined);

export interface VisionDescribeToolOptions {
  provider: VisionProviderSource;
  /** Per-call image count cap mirrored from `config.vision.maxImagesPerCall`. */
  maxImagesPerCall: number;
  /** Per-image byte cap mirrored from `config.vision.maxImageBytes`. */
  maxImageBytes: number;
  /**
   * Where to send the operator when the model serving the step cannot
   * read images: vision-capable models on the same provider, from its
   * catalogue. Called only on a refusal. Absent or empty, the refusal
   * points at `/model` and local vision models in general.
   */
  visionAlternatives?: (providerId: string) => readonly string[];
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
      // Resolved per call, never captured: the provider serving THIS
      // step is the one whose capability counts and the one called.
      // No fallback to another provider — a refusal names the route.
      const provider =
        typeof options.provider === "function"
          ? options.provider(ctx.providerId)
          : options.provider;
      if (provider === undefined) {
        return errorResult(
          `vision is not available: provider "${ctx.providerId ?? "(active)"}" is not configured`,
        );
      }
      if (!provider.capabilities.vision) {
        return cannotSeeResult(provider, options);
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
        const result = await provider.describeImage({
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
              provider: provider.name,
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
          // The capability flipped under the call: a local profile swap
          // to a text-only model, or the service rejected the image for
          // a model nobody had described (`ModelCannotSeeError`, which
          // recorded it). Same terminal answer as the up-front refusal.
          return cannotSeeResult(provider, options, error.message);
        }
        return errorResult(`vision call failed: ${(error as Error).message}`);
      }
    },
  };
}

function errorResult(
  message: string,
  details?: Record<string, unknown>,
  compressorOptions?: Partial<CompressorOptions>,
) {
  return compressToolResult(
    {
      tool: "vision.describe",
      status: "error",
      output: message,
      ...(details ? { details } : {}),
    },
    compressorOptions,
  );
}

/**
 * Why a provider's `capabilities.vision` reads false, in the words an
 * operator can act on. Keyed by `visionSource`.
 */
const CANNOT_SEE_REASONS: Partial<Record<string, string>> = {
  "config.userModels": "its llm.providers[].userModels[] entry sets supportsVision: false",
  "config.provider": "its llm.providers[] entry sets supportsVision: false",
  catalog: "the model catalogue lists it as text-only",
  "catalog.live": "the provider's model list says it takes no image input",
  "rejected-images": "the service rejected an image sent to it",
  "config-disabled": "this provider takes no image input",
  "auto-detect-disabled": "vision is disabled in config",
};

/**
 * The refusal for "the model serving this step cannot read images",
 * whether known up front or learned from the call just made. It names
 * the model AND the provider, says where to go, and tells the agent in
 * so many words that a retry cannot succeed — there is no retry
 * classifier for tool results, so the text and the machine-readable
 * `retryable: false` are what stop the loop, together with the
 * descriptor leaving the prompt on the next step (`vision-route.ts`).
 */
function cannotSeeResult(
  provider: LlmProvider,
  options: VisionDescribeToolOptions,
  serviceMessage?: string,
) {
  const providerId = provider.id ?? provider.name;
  const model = provider.chatModelId;
  const source = provider.capabilities.visionSource;
  const who = model ? `${model} on ${providerId}` : `the model on ${providerId}`;
  const reason =
    (serviceMessage !== undefined
      ? clip(serviceMessage, SERVICE_MESSAGE_MAX_CHARS)
      : undefined) ??
    CANNOT_SEE_REASONS[source] ??
    "no vision projector (mmproj) is loaded for it";
  const alternatives = options.visionAlternatives?.(providerId) ?? [];
  const where =
    alternatives.length > 0
      ? `${alternatives.join(", ")} via /model, or a local model with a vision projector`
      : "/model, or a local model with a vision projector";
  return errorResult(
    `${who} cannot read images (${reason}) — switch to a vision model (${where}). ` +
      "Retrying vision.describe on this model fails the same way: do not call it again " +
      "or try to read the image another way; tell the user the image cannot be read on the current model.",
    {
      retryable: false,
      reason: "model-cannot-see",
      provider: providerId,
      ...(model ? { model } : {}),
      visionSource: source,
    },
    // The whole refusal must reach the model: the default 400-char
    // summary would cut the instruction that stops the retry loop.
    VISION_COMPRESSOR_OPTIONS,
  );
}

/** Enough of the service's own words to recognise the error. */
const SERVICE_MESSAGE_MAX_CHARS = 240;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
