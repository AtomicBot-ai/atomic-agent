/**
 * The one place that says whether a request goes to Google's
 * OpenAI-compatible Gemini endpoint (ATO-1282): by the host of the base
 * URL, so a `gemini` entry and an `openai-compatible` entry pointed at
 * `generativelanguage.googleapis.com/v1beta/openai` are treated alike.
 *
 * Kept free of imports so the OpenAI provider and its HTTP layer can use
 * it without a cycle through `gemini-provider.ts`.
 */
export const GEMINI_OPENAI_COMPAT_HOST = "generativelanguage.googleapis.com";

export function isGeminiOpenAiCompatUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === GEMINI_OPENAI_COMPAT_HOST;
  } catch {
    return false;
  }
}

/**
 * Gemini's 404 names the model it could not find:
 * "models/gemini-9-flash is not found for API version v1beta, or is not
 * supported for generateContent. Call ListModels …".
 */
const MODEL_NOT_FOUND = /\bmodels\/([A-Za-z0-9._:\-]{1,120}) is not found\b/;

export function geminiModelFromNotFound(text: string): string | null {
  return MODEL_NOT_FOUND.exec(text)?.[1] ?? null;
}

/**
 * What the user reads for a 404 from that endpoint. Keeps "answered 404"
 * so the desktop still reads it as the provider having replied. Only a
 * body that names a missing model is told as one; any other 404 (a wrong
 * base path such as `/v1beta` without `/openai`, a typo) keeps the
 * generic "model id or base URL" sentence.
 */
export function geminiNotFoundSentence(who: string, text: string): string {
  const model = geminiModelFromNotFound(text);
  if (model === null) {
    return `${who} answered 404 (not found). The model id or the base URL is likely wrong.`;
  }
  return (
    `${who} answered 404: the model "${model}" is not available on Gemini. ` +
    `Check the model id against the Gemini model list, or pick another model.`
  );
}
