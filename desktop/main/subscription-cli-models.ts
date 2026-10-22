/**
 * ATO-844: the model list for a subscription-CLI provider (`claude-cli`,
 * `codex-cli`). These providers have no HTTP endpoint, so there is nothing to
 * fetch: asking the agent's model index for one would hang on a request that
 * never completes, or hand back another kind's placeholder.
 *
 * The desktop is built separately from the ESM agent, so the Claude list
 * mirrors src/llm/provider/subscription-cli/claude-cli-models.ts and the TUI's
 * own rule (llm-panel-row-builders.ts): Claude ships a curated list, Codex
 * publishes none and resolves the model itself, so its list is only what the
 * entry pinned. subscription-cli-models.test.mjs fails if the copy drifts.
 */

export const SUBSCRIPTION_CLI_KIND = "subscription-cli";

/** CLAUDE_CLI_CHAT_MODELS: aliases first, then the pinned ids. */
export const CLAUDE_CLI_CHAT_MODELS: readonly string[] = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8",
];

/** CLAUDE_CLI_DEFAULT_CHAT_MODEL: the alias, so the plan's current model is used. */
export const CLAUDE_CLI_DEFAULT_CHAT_MODEL = "sonnet";

interface SubscriptionEntry {
  id: string;
  kind: string;
  defaultChatModel?: string;
  model?: string;
  subscriptionCli?: { cli?: string };
}

/** The models to offer for a subscription-CLI entry, the pinned one first. */
export function subscriptionCliModels(entry: SubscriptionEntry): { provider: string; id: string }[] {
  const out = new Set<string>();
  if (entry.defaultChatModel) out.add(entry.defaultChatModel);
  if (entry.model) out.add(entry.model);
  if (entry.subscriptionCli?.cli === "claude") for (const id of CLAUDE_CLI_CHAT_MODELS) out.add(id);
  return [...out].map((id) => ({ provider: entry.id, id }));
}
