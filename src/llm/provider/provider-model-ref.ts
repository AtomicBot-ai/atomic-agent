/**
 * `provider/model` or `provider:model` (ATO-2773). Favorite models used
 * the slash and `run -m` and `--models` the colon, so an id copied from
 * one place did not work in the other. Every input now takes both, and
 * help and listings write the slash form (opencode and pi spell a model
 * `provider/model`).
 *
 * The split is at whichever separator comes first. Provider ids are
 * kebab-case (`PROVIDER_ID_RE` in config/llm-config.ts) and hold
 * neither, while model ids may hold both: `openrouter/openai/gpt-oss`,
 * `ollama:qwen3:8b`, `local-llama/qwen3:8b`.
 */
export interface ProviderModelRef {
  provider: string;
  model: string;
}

/** The first `/` or `:` in `text`, or -1. */
export function providerModelSeparator(text: string): number {
  const slash = text.indexOf("/");
  const colon = text.indexOf(":");
  if (slash === -1) return colon;
  if (colon === -1) return slash;
  return Math.min(slash, colon);
}

/** Null without a separator, with an empty side, or with whitespace. */
export function splitProviderModel(raw: string): ProviderModelRef | null {
  const text = raw.trim();
  const at = providerModelSeparator(text);
  if (at <= 0 || at === text.length - 1 || /\s/.test(text)) return null;
  return { provider: text.slice(0, at), model: text.slice(at + 1) };
}

/** The display form. */
export function formatProviderModel(ref: ProviderModelRef): string {
  return `${ref.provider}/${ref.model}`;
}
