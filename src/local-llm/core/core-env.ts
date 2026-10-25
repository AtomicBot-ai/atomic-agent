/**
 * The environment the detached Atomic Core daemon is spawned with.
 *
 * The agent's own environment carries every cloud provider key the user
 * configured (loaded from `<stateDir>/.env` at bootstrap), and Core is a
 * long-lived process that outlives the agent. It needs none of them: it
 * only installs inference backends and serves local models. So anything
 * secret-shaped is dropped, and PATH, HOME, TMPDIR, locale, proxy and
 * platform variables pass through unchanged.
 *
 * Names are matched without regard to case: Windows environment names are
 * case-insensitive. The domain-local list below names the known provider
 * variables explicitly so a future variable without a secret-shaped name
 * (none today) is still caught; the name patterns cover the rest
 * (AWS_SESSION_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, SSH_AUTH_SOCK, ...).
 */
const KNOWN_SECRET_VARS = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY", "ATOMIC_CHAT_API_KEY",
  "CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GROQ_API_KEY",
  "HYPERBOLIC_API_KEY", "LMSTUDIO_API_KEY", "MISTRAL_API_KEY", "MOONSHOT_API_KEY",
  "NOUS_API_KEY", "NOVITA_API_KEY", "PERPLEXITY_API_KEY", "DASHSCOPE_API_KEY",
  "SAMBANOVA_API_KEY", "SARVAM_API_KEY", "TOGETHER_API_KEY", "XAI_API_KEY",
  "EXA_API_KEY", "LLAMA_API_KEY", "ATOMIC_AGENT_LLAMA_API_KEY",
  "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN",
]);

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE/i;

export function isSecretEnvName(name: string): boolean {
  return KNOWN_SECRET_VARS.has(name.toUpperCase()) || SECRET_NAME.test(name);
}

export function coreDaemonEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isSecretEnvName(key)) env[key] = value;
  }
  env.ATOMIC_CORE_TELEMETRY = "off";
  return env;
}
