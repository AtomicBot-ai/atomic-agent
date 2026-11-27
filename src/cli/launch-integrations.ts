/**
 * ATO-2172: one descriptor per coding CLI that `atag launch` can start
 * against `atag serve`. Pure: each descriptor turns the serve address, the
 * key and the model label into the environment and arguments the CLI is
 * spawned with. Modelled on Ollama's `cmd/launch` package (one file per
 * integration: binary, env, args), e.g. `cmd/launch/claude.go`.
 *
 * The key always travels in an environment variable, never in an argument,
 * so it does not show up in `ps` and `--print-env` can mask it by name.
 */

/** What every integration is built from. */
export interface LaunchTarget {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly baseUrl: string;
  /** The serve API key. */
  readonly token: string;
  /** The model name the CLI sends; the active agent model answers whatever it is. */
  readonly model: string;
  /** Whether the person passed `--model` (Claude Code keeps its own names otherwise). */
  readonly modelGiven: boolean;
  /** Everything after `--`, handed to the CLI unchanged. */
  readonly extraArgs: readonly string[];
}

export interface LaunchPlan {
  /** Variables set (or, with an empty value, cleared) on top of the inherited environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  /** Names in `env` whose values are secrets: masked by `--print-env`. */
  readonly secretEnv: readonly string[];
}

export interface LaunchIntegration {
  readonly id: string;
  /** Other names accepted on the command line. */
  readonly aliases: readonly string[];
  readonly displayName: string;
  /** Executable looked up on PATH. */
  readonly binary: string;
  /** Printed when the binary is missing. */
  readonly installHint: string;
  build(target: LaunchTarget): LaunchPlan;
}

/** Name of the variable that carries the key for Codex and OpenCode. */
export const LAUNCH_TOKEN_ENV = "ATOMIC_AGENT_TOKEN";

/** Model label used when `--model` is not given: the id `GET /v1/models` lists. */
export const DEFAULT_LAUNCH_MODEL = "atomic-agent";

const claude: LaunchIntegration = {
  id: "claude",
  aliases: ["claude-code"],
  displayName: "Claude Code",
  binary: "claude",
  installHint: "npm install -g @anthropic-ai/claude-code",
  build(target) {
    // Same variables as `ollama launch claude`: the base URL without /v1
    // (Claude Code appends /v1/messages), the key as a bearer token, and
    // ANTHROPIC_API_KEY cleared so a key in the shell does not take over.
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: target.baseUrl,
      ANTHROPIC_AUTH_TOKEN: target.token,
      ANTHROPIC_API_KEY: "",
    };
    if (target.modelGiven) {
      env.ANTHROPIC_MODEL = target.model;
      env.ANTHROPIC_SMALL_FAST_MODEL = target.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = target.model;
    }
    return { env, args: [...target.extraArgs], secretEnv: ["ANTHROPIC_AUTH_TOKEN"] };
  },
};

/** A TOML basic string, for Codex `-c key=value` overrides. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const codex: LaunchIntegration = {
  id: "codex",
  aliases: [],
  displayName: "Codex",
  binary: "codex",
  installHint: "npm install -g @openai/codex",
  build(target) {
    // A custom model provider through `-c` overrides, so nothing is written
    // to ~/.codex/config.toml. `wire_api = "responses"`: serve answers
    // POST /v1/responses (ATO-1080), the API current Codex speaks.
    const provider = "model_providers.atomic";
    const overrides = [
      `model_provider=${tomlString("atomic")}`,
      `${provider}.name=${tomlString("Atomic Agent")}`,
      `${provider}.base_url=${tomlString(`${target.baseUrl}/v1`)}`,
      `${provider}.env_key=${tomlString(LAUNCH_TOKEN_ENV)}`,
      `${provider}.wire_api=${tomlString("responses")}`,
    ];
    const args = [...overrides.flatMap((o) => ["-c", o]), "-m", target.model, ...target.extraArgs];
    return { env: { [LAUNCH_TOKEN_ENV]: target.token }, args, secretEnv: [LAUNCH_TOKEN_ENV] };
  },
};

/** The OpenCode config passed inline; the key is read from the environment by OpenCode. */
export function openCodeConfig(target: Pick<LaunchTarget, "baseUrl" | "model">): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      atomic: {
        npm: "@ai-sdk/openai-compatible",
        name: "Atomic Agent",
        options: { baseURL: `${target.baseUrl}/v1`, apiKey: `{env:${LAUNCH_TOKEN_ENV}}` },
        models: { [target.model]: { name: target.model } },
      },
    },
    model: `atomic/${target.model}`,
  });
}

const opencode: LaunchIntegration = {
  id: "opencode",
  aliases: [],
  displayName: "OpenCode",
  binary: "opencode",
  installHint: "npm install -g opencode-ai",
  build(target) {
    // OPENCODE_CONFIG_CONTENT is merged over the person's own config for
    // this run only; the key stays in ATOMIC_AGENT_TOKEN via `{env:...}`.
    return {
      env: { OPENCODE_CONFIG_CONTENT: openCodeConfig(target), [LAUNCH_TOKEN_ENV]: target.token },
      args: [...target.extraArgs],
      secretEnv: [LAUNCH_TOKEN_ENV],
    };
  },
};

export const LAUNCH_INTEGRATIONS: readonly LaunchIntegration[] = [claude, codex, opencode];

export function findLaunchIntegration(name: string): LaunchIntegration | null {
  const key = name.trim().toLowerCase();
  return LAUNCH_INTEGRATIONS.find((i) => i.id === key || i.aliases.includes(key)) ?? null;
}
