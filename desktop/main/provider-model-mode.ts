export type ModelMode = "local" | "cloud";

interface ProviderModeInput {
  kind: string;
  baseUrl?: string;
  subscriptionCli?: { cli?: string };
}

// The desktop is built separately from the ESM agent. Mirror the initial
// save policy in src/config/model-mode.ts; provider-model-mode.test.mjs
// compares both implementations against the agent's current presets.
const CLOUD_ORIGINS = new Set([
  "https://api.openai.com",
  "https://api.anthropic.com",
  "https://api.cerebras.ai",
  "https://api.deepseek.com",
  "https://api.fireworks.ai",
  "https://api.groq.com",
  "https://api.hyperbolic.xyz",
  "https://api.mistral.ai",
  "https://api.moonshot.ai",
  "https://inference-api.nousresearch.com",
  "https://api.novita.ai",
  "https://ollama.com",
  "https://api.perplexity.ai",
  "https://dashscope-intl.aliyuncs.com",
  "https://api.sambanova.ai",
  "https://api.sarvam.ai",
  "https://api.together.xyz",
  "https://api.x.ai",
]);

/** Only for a new connection. Existing choices, including inherit, stay put. */
export function defaultProviderModelMode(entry: ProviderModeInput): ModelMode {
  if (
    entry.kind === "openrouter" || entry.kind === "aimlapi" ||
    entry.kind === "gemini" ||
    (entry.kind === "subscription-cli" && Boolean(entry.subscriptionCli?.cli))
  ) return "cloud";
  if (entry.kind !== "openai-compatible" || !entry.baseUrl) return "local";
  try {
    if (CLOUD_ORIGINS.has(new URL(entry.baseUrl).origin)) return "cloud";
  } catch {
    // Invalid/custom endpoints retain the core's conservative local policy.
  }
  return "local";
}
