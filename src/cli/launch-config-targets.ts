/**
 * ATO-2448: where each CLI keeps the setting `atag launch --config`
 * writes, and what goes in it. Pure: paths come from the environment and
 * home folder handed in. Modelled on Ollama's `cmd/launch` editors
 * (claude.go, codex.go, opencode.go): the same files and keys.
 *
 * The key is never written in clear where the CLI can fetch it itself:
 * Claude Code runs `apiKeyHelper` (`atag launch --print-key`), OpenCode
 * reads `{file:...}` or `{env:...}`, Codex reads the variable named by
 * `env_key`, which the person exports in their shell.
 */

import { join } from "node:path";

import type { JsonEdit } from "./launch-config-json.js";
import type { CodexTomlSettings } from "./launch-config-toml.js";
import { LAUNCH_TOKEN_ENV, tomlString } from "./launch-integrations.js";

export interface PersistInput {
  /** `http://127.0.0.1:<port>` or `.../local`, no trailing slash. */
  readonly baseUrl: string;
  readonly model: string;
  /** Whether to write the model name (local mode, or `--model`). */
  readonly modelGiven: boolean;
  /** Shell command that prints the key (`"<atag>" launch --print-key`). */
  readonly keyCommand: string;
  /** Where the key can be read from without a shell, for OpenCode. */
  readonly keySource: { readonly kind: "file"; readonly path: string } | { readonly kind: "env"; readonly name: string };
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}

export type PersistSpec =
  | { readonly kind: "json"; readonly file: string; readonly edits: readonly JsonEdit[]; readonly note?: string }
  | { readonly kind: "codex-toml"; readonly file: string; readonly settings: CodexTomlSettings; readonly note?: string };

export function claudeSettingsPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() ? env.CLAUDE_CONFIG_DIR.trim() : join(home, ".claude");
  return join(dir, "settings.json");
}

export function codexConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CODEX_HOME?.trim() ? env.CODEX_HOME.trim() : join(home, ".codex");
  return join(dir, "config.toml");
}

export function openCodeConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  // OpenCode uses the XDG folder on every platform, Windows included.
  const dir = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME.trim() : join(home, ".config");
  return join(dir, "opencode", "opencode.json");
}

function claudeSpec(input: PersistInput): PersistSpec {
  const edits: JsonEdit[] = [
    { path: ["env", "ANTHROPIC_BASE_URL"], value: input.baseUrl },
    { path: ["apiKeyHelper"], value: input.keyCommand },
  ];
  if (input.modelGiven) {
    for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
      edits.push({ path: ["env", name], value: input.model });
    }
  }
  return { kind: "json", file: claudeSettingsPath(input.env, input.home), edits };
}

function codexSpec(input: PersistInput): PersistSpec {
  return {
    kind: "codex-toml",
    file: codexConfigPath(input.env, input.home),
    settings: {
      topLevel: [`model_provider = ${tomlString("atomic")}`, `model = ${tomlString(input.model)}`],
      table: [
        "[model_providers.atomic]",
        `name = ${tomlString("Atomic Agent")}`,
        `base_url = ${tomlString(`${input.baseUrl}/v1`)}`,
        `env_key = ${tomlString(LAUNCH_TOKEN_ENV)}`,
        `wire_api = ${tomlString("responses")}`,
      ],
    },
    note: exportNote("Codex", input.keyCommand),
  };
}

function openCodeSpec(input: PersistInput): PersistSpec {
  const apiKey = input.keySource.kind === "file" ? `{file:${input.keySource.path}}` : `{env:${input.keySource.name}}`;
  return {
    kind: "json",
    file: openCodeConfigPath(input.env, input.home),
    edits: [
      {
        path: ["provider", "atomic"],
        value: {
          npm: "@ai-sdk/openai-compatible",
          name: "Atomic Agent",
          options: { baseURL: `${input.baseUrl}/v1`, apiKey },
          models: { [input.model]: { name: input.model } },
        },
      },
      { path: ["model"], value: `atomic/${input.model}` },
    ],
  };
}

export function qwenSettingsPath(home: string): string {
  return join(home, ".qwen", "settings.json");
}

/** The export line for a CLI that reads the key from ATOMIC_AGENT_TOKEN. */
function exportNote(cli: string, keyCommand: string): string {
  return (
    `${cli} reads the key from ${LAUNCH_TOKEN_ENV}. Add this line to your shell profile (~/.zshrc, ~/.bashrc):\n` +
    `  export ${LAUNCH_TOKEN_ENV}="$(${keyCommand})"\n` +
    `On Windows (PowerShell profile): $env:${LAUNCH_TOKEN_ENV} = (${keyCommand.replace(/^"([^"]+)"/, "& \"$1\"")})\n`
  );
}

function qwenSpec(input: PersistInput): PersistSpec {
  // As Ollama's qwen.go: our entry first in `modelProviders.openai`, the
  // person's other entries kept after it, the OpenAI auth type selected.
  const baseUrl = `${input.baseUrl}/v1`;
  const ours = { id: input.model, name: `${input.model} (Atomic Agent)`, baseUrl, envKey: LAUNCH_TOKEN_ENV };
  const isOurs = (entry: unknown): boolean => (entry as { envKey?: unknown } | null)?.envKey === LAUNCH_TOKEN_ENV;
  return {
    kind: "json",
    file: qwenSettingsPath(input.home),
    edits: [
      {
        path: ["modelProviders", "openai"],
        value: [ours],
        merge: (current) => [ours, ...(Array.isArray(current) ? current.filter((entry) => !isOurs(entry)) : [])],
      },
      { path: ["security", "auth", "selectedType"], value: "openai" },
      { path: ["security", "auth", "baseUrl"], value: baseUrl },
      { path: ["model", "name"], value: input.model },
    ],
    note: exportNote("Qwen Code", input.keyCommand),
  };
}

const SPECS: Readonly<Record<string, (input: PersistInput) => PersistSpec>> = {
  claude: claudeSpec,
  codex: codexSpec,
  opencode: openCodeSpec,
  qwen: qwenSpec,
};

/** The persistent setting for an integration, or null when it has none. */
export function persistSpecFor(id: string, input: PersistInput): PersistSpec | null {
  const spec = SPECS[id];
  return spec ? spec(input) : null;
}
