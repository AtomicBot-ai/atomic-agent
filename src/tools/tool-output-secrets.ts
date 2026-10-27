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
 * The summary, the kept uncompressed copy (`fullOutput`) and the two
 * details the step puts in the prompt (a browser snapshot, a loaded
 * skill's body) are masked, so cloud mode's promoted output and the
 * local spill file (`tool-output-spill.ts`) carry the marker too.
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
 * The two `details` fields the step folds into the prompt
 * (`applyStateEffects`): a browser tool's `worldSnapshot.text` becomes
 * `### world`, `skill.view`'s `skillLoaded.body` becomes a loaded skill.
 * Every other detail stays as the tool wrote it; the prompt does not
 * render them.
 */
const PROMPT_DETAIL_FIELDS: readonly (readonly [string, string])[] = [
  ["worldSnapshot", "text"],
  ["skillLoaded", "body"],
];

function maskPromptDetails(
  details: Record<string, unknown>,
  known: readonly KnownSecret[],
): Record<string, unknown> {
  // A hand-built result may omit `details` despite its type.
  if (details === null || typeof details !== "object") return details;
  let out = details;
  for (const [field, key] of PROMPT_DETAIL_FIELDS) {
    const holder = details[field];
    if (holder === null || typeof holder !== "object") continue;
    const text = (holder as Record<string, unknown>)[key];
    if (typeof text !== "string") continue;
    const masked = maskSecrets(text, known);
    if (masked === text) continue;
    if (out === details) out = { ...details };
    out[field] = { ...(holder as Record<string, unknown>), [key]: masked };
  }
  return out;
}

/**
 * `result` with secrets masked in its summary, full output and the
 * prompt-bound details, or `result` itself when there was nothing to mask.
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
  const details = maskPromptDetails(result.details, known);
  if (summary === result.summary && full === result.fullOutput && details === result.details) {
    return result;
  }
  const masked: CompressedToolResult = { ...result, summary, details };
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
 * A thrown value with its secrets masked, so the error result the
 * dispatcher builds from it (`batch-scheduler.ts`, which reads
 * `err.message` or `String(err)`) cannot carry a key a provider or a CLI
 * echoed back. An `Error` is masked in place and returned as itself, so
 * its class and cancellation semantics are unchanged. Anything else is
 * replaced by a masked `Error` when its text held a secret, and returned
 * unchanged otherwise.
 */
export function maskErrorSecrets(err: unknown, known: readonly KnownSecret[] = []): unknown {
  if (err instanceof Error) {
    const message = maskSecrets(err.message, known);
    if (message !== err.message) {
      try {
        err.message = message;
      } catch {
        // A frozen error keeps its message; nothing better to do here.
      }
    }
    return err;
  }
  let text: string;
  try {
    text = String(err);
  } catch {
    return err;
  }
  const masked = maskSecrets(text, known);
  return masked === text ? err : new Error(masked);
}
