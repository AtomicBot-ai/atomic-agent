/**
 * Gemini 3's thought signatures on the OpenAI-compatible endpoint
 * (ATO-1680).
 *
 * A tool call Gemini 3 emits carries an opaque signature of the thinking
 * behind it, in a vendor field beside `function`:
 * `tool_calls[i].extra_content.google.thought_signature`. Of a parallel
 * set only the first call has one. The next request must hand it back on
 * that call, byte for byte, or Gemini answers 400 "Function call is
 * missing a thought_signature". The runtime keeps it on the recorded
 * call and the native message builder writes it back.
 *
 * A call with no signature of its own (a transcript recorded before this
 * existed, a call another model made, an imported session) gets
 * {@link SKIP_THOUGHT_SIGNATURE}, the value Google documents for
 * history it cannot validate. Only Google's endpoint gets either field:
 * strict OpenAI-compatible services refuse unknown fields.
 *
 * Kept free of imports, like `gemini-openai-compat.ts`.
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** The signature a raw `tool_calls` entry (or stream delta) carries, if any. */
export function readThoughtSignature(toolCall: unknown): string | undefined {
  if (toolCall === null || typeof toolCall !== "object") return undefined;
  const extra = (toolCall as { extra_content?: unknown }).extra_content;
  if (extra === null || typeof extra !== "object") return undefined;
  const google = (extra as { google?: unknown }).google;
  if (google === null || typeof google !== "object") return undefined;
  const signature = (google as { thought_signature?: unknown }).thought_signature;
  return typeof signature === "string" && signature.length > 0 ? signature : undefined;
}

/** The `extra_content` a call in the history carries back to Gemini. */
export function thoughtSignatureExtraContent(signature: string): {
  google: { thought_signature: string };
} {
  return { google: { thought_signature: signature } };
}
