import { presetForEntryId } from "./presets/provider-presets.js";

/**
 * The built-in kinds by the names their services go by, as the TUI's
 * providers screens write them (`KIND_SERVICE_LABELS` in
 * src/tui/providers/providers-wizard-target.ts).
 */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  aimlapi: "AI/ML API",
  gemini: "Gemini",
};

/**
 * A provider entry id as a sentence names it: "AI/ML API" for `aimlapi`,
 * "DeepSeek" for `deepseek` or `deepseek-2`, "Qwen" for `dashscope` (a
 * preset's label up to its parenthesis, as the desktop shows it). An id
 * that is none of these is quoted, the way every other failure sentence
 * quotes it: a custom entry's id is the only name it has.
 */
export function providerServiceName(id: string): string {
  const base = /^(.+)-\d+$/.exec(id)?.[1] ?? id;
  const named =
    SERVICE_NAMES[id] ??
    SERVICE_NAMES[base] ??
    presetForEntryId(id)?.label.split(" (")[0];
  return named !== undefined && named.length > 0 ? named : `"${id}"`;
}
