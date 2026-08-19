/**
 * Models the `claude` CLI accepts for `--model`. The CLI exposes no
 * list command, so this is curated: aliases first because they keep
 * working across releases, then the pinned ids for reproducibility.
 *
 * When Anthropic ships a new model, add its id here — nothing else in
 * the provider needs to change.
 */
export const CLAUDE_CLI_MODEL_ALIASES = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
] as const;

export const CLAUDE_CLI_MODEL_IDS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8",
] as const;

export const CLAUDE_CLI_CHAT_MODELS: readonly string[] = [
  ...CLAUDE_CLI_MODEL_ALIASES,
  ...CLAUDE_CLI_MODEL_IDS,
];

/**
 * The alias, not a pinned id: a subscription user wants the current
 * model behind the name they already use in Claude Code.
 */
export const CLAUDE_CLI_DEFAULT_CHAT_MODEL = "sonnet";

/**
 * Conservative floor rather than the 1M ceiling the top models carry.
 * This only feeds `capabilities.contextWindow`, which the runtime uses
 * to decide when to compact — overstating it for a `haiku` session
 * would let the prompt grow past what that model accepts.
 */
export const CLAUDE_CLI_CONTEXT_WINDOW = 200_000;
