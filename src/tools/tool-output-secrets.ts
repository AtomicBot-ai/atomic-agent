/**
 * Credentials in tool output are masked before the model reads them
 * (ATO-1077).
 *
 * `cat .env`, `env`, `git remote -v`, an HTTP body that echoes a header,
 * a config file read with `os.fs.read`: any of them puts a live key in
 * the result, and from there in the prompt, the transcript, the trace
 * and (in cloud mode) a provider's logs. A prompt-injected page can then
 * ask the model to send it on. `ToolRegistry.invoke` runs every result
 * through {@link maskResultSecrets}, so the key is replaced by a marker
 * such as `[redacted:openrouter-key]` before any of those see it. The
 * detector is shared with the error scrubber
 * (`src/error-reporting/secret-detector.ts`).
 *
 * Both the summary and the kept uncompressed copy (`fullOutput`) are
 * masked, so cloud mode's promoted output and the local spill file
 * (`tool-output-spill.ts`) carry the marker too.
 *
 * The terminal tools are left alone: `reply` and `finish` carry the
 * model's own words to the user, not output from outside.
 */
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  maskSecrets,
  type KnownSecret,
} from "../error-reporting/secret-detector.js";

/** Tools whose result is the model's own text, not tool output. */
export const UNMASKED_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

/**
 * `result` with secrets masked in its summary and full output, or
 * `result` itself when there was nothing to mask.
 */
export function maskResultSecrets(
  result: CompressedToolResult,
  known: readonly KnownSecret[] = [],
): CompressedToolResult {
  const summary = maskSecrets(result.summary, known);
  const full =
    result.fullOutput === undefined
      ? undefined
      : maskSecrets(result.fullOutput, known);
  if (summary === result.summary && full === result.fullOutput) return result;
  const masked: CompressedToolResult = { ...result, summary };
  // The uncompressed copy is a non-enumerable property the spread above
  // drops; keep it, masked the same way, for `fullToolResult` and the spill.
  if (full !== undefined) {
    Object.defineProperty(masked, "fullOutput", { value: full, enumerable: false });
    Object.defineProperty(masked, "fullOutputTruncated", {
      value: result.fullOutputTruncated,
      enumerable: false,
    });
  }
  return masked;
}

/**
 * Mask secrets in a thrown error's message in place, so the error result
 * the dispatcher builds from it (`batch-scheduler.ts`) cannot carry a key
 * a provider or a CLI echoed back. The error object itself is kept, so
 * its class and cancellation semantics are unchanged.
 */
export function maskErrorSecrets(err: unknown, known: readonly KnownSecret[] = []): void {
  if (!(err instanceof Error) || typeof err.message !== "string") return;
  const message = maskSecrets(err.message, known);
  if (message === err.message) return;
  try {
    err.message = message;
  } catch {
    // A frozen error keeps its message; nothing better to do here.
  }
}
