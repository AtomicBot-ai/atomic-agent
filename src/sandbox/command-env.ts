/**
 * The environment an agent-run command is spawned with (ATO-347).
 *
 * Bootstrap loads `<stateDir>/.env` into the agent's own `process.env`,
 * so it carries every provider key and bot token configured here. A
 * command the model runs (`os.shell.run`, `os.git.*`) inherited all of
 * them, and a prompt-injected `env` or `curl ... $OPENAI_API_KEY` could
 * read them out. The agent itself keeps reading its keys as before; only
 * the child's copy is filtered.
 *
 * Unlike a stdio MCP server (`src/mcp/mcp-stdio-env.ts`, an allowlist), a
 * shell command needs the user's whole working environment: PATH, HOME,
 * locale, toolchain variables (`NVM_DIR`, `JAVA_HOME`, `GOPATH`, ...). So
 * this is a deny filter: a variable is dropped when its name looks like
 * a secret (`isSecretEnvName`) or is a known provider/bot credential
 * (`KNOWN_SECRET_ENV_VARS`). Everything else passes unchanged.
 *
 * Two ways back in, both explicit:
 * - `passthrough` names (`tools.shell.envPassthrough` in config) are
 *   copied from the agent's env even when they look like a secret;
 * - a command line that sets a variable itself (`FOO_TOKEN=x cmd`) is
 *   untouched, since the filter only applies to what is inherited.
 *
 * Names match without regard to case, because Windows environment names
 * are case-insensitive.
 */

/**
 * Credentials the agent or its integrations read, dropped whatever the
 * pattern says. Most also match `isSecretEnvName`; the list exists so a
 * future rename of the pattern cannot silently let one of these through,
 * and so the filter is greppable by the exact names people search for.
 */
export const KNOWN_SECRET_ENV_VARS: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "PERPLEXITY_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
  "NOVITA_API_KEY",
  "HYPERBOLIC_API_KEY",
  "SAMBANOVA_API_KEY",
  "SARVAM_API_KEY",
  "NOUS_API_KEY",
  "AIMLAPI_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_CLOUD_API_KEY",
  "LMSTUDIO_API_KEY",
  "VLLM_API_KEY",
  "LLAMA_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "ATOMIC_AGENT_API_KEY",
  "ATOMIC_AGENT_LLAMA_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
  "ATOMIC_CHAT_API_KEY",
  "ATOMIC_MAIL_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "COMPOSIO_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "CLAWHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
];

const KNOWN = new Set(KNOWN_SECRET_ENV_VARS.map((name) => name.toUpperCase()));

/**
 * Substrings that mark a secret wherever they sit in the name
 * (`PGPASSWORD`, `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `MY_APIKEY`).
 */
const SECRET_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "APIKEY",
  "API_KEY",
  "PRIVATE_KEY",
  "ACCESS_KEY",
];

/**
 * `KEY` alone counts only as a whole `_`-separated segment
 * (`STRIPE_KEY`, `KEY_ID`), so `GNOME_KEYRING_CONTROL` or `KEYMAP`
 * (paths and settings, not secrets) survive.
 */
const KEY_SEGMENTS = new Set(["KEY", "KEYS"]);

/** Whether `name` looks like it holds a credential. */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (KNOWN.has(upper)) return true;
  if (SECRET_SUBSTRINGS.some((part) => upper.includes(part))) return true;
  return upper.split(/[^A-Z0-9]+/).some((segment) => KEY_SEGMENTS.has(segment));
}

/**
 * Build the child environment for an agent-run command: `base` without
 * secret-looking variables, except those named in `passthrough`.
 */
export function buildCommandEnv(
  base: NodeJS.ProcessEnv = process.env,
  passthrough: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set(passthrough.map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    if (isSecretEnvName(key) && !allowed.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return env;
}
