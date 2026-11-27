import { extname } from "node:path";

import type { ToolSecretSource } from "../../config/tool-secrets.js";
import { checkToolSecretNames, fillToolSecretTexts, type ToolSecretCheck } from "../tool-secret-use.js";

/**
 * `{{secret:NAME}}` in `skill.run_script` (ATO-2530): in `args`, and in
 * `env`, which sets only the variables the skill declared in `env_keys`
 * for this one run (`{"GITHUB_TOKEN": "{{secret:GITHUB_TOKEN}}"}`).
 * Checked before the approval, filled in after it, and only into what
 * is spawned; the preview and every record keep the placeholders.
 */

/**
 * The `env` argument, `[{name, value}]` (a `{name: value}` map is read
 * too): only the skill's own `env_keys`. Any other name is refused, so a
 * call cannot set `PATH` or `NODE_OPTIONS` for a script the human
 * approved by name.
 */
export function parseScriptEnv(raw: unknown, envKeys: readonly string[]): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") throw new Error("skill.run_script: `env` must be a list of {name, value}");
  const entries: [unknown, unknown][] = Array.isArray(raw)
    ? raw.map((item: unknown): [unknown, unknown] => {
        const entry = (item ?? {}) as { name?: unknown; value?: unknown };
        return [entry.name, entry.value];
      })
    : Object.entries(raw);
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || !envKeys.includes(key)) {
      throw new Error(
        `skill.run_script: env ${String(key)} is not one of this skill's env_keys (${envKeys.length > 0 ? envKeys.join(", ") : "none declared"})`,
      );
    }
    if (typeof value !== "string") throw new Error(`skill.run_script: env ${key} must be a string`);
    env[key] = value;
  }
  return env;
}

export function checkScriptSecrets(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  source: ToolSecretSource | undefined,
): ToolSecretCheck {
  return checkToolSecretNames([...args, ...Object.values(env)], source);
}

export type ScriptSecretFill =
  | { ok: true; args: string[]; env: Record<string, string> }
  | { ok: false; message: string };

/**
 * `args` and `env` with the values filled in. A `.cmd`/`.bat` script
 * runs through `cmd.exe`, which reads its line as syntax, so a value
 * there must be plain token characters; every other script gets argv.
 */
export async function fillScriptSecrets(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  names: readonly string[],
  source: ToolSecretSource,
): Promise<ScriptSecretFill> {
  const ext = extname(script).toLowerCase();
  const viaCmd = ext === ".cmd" || ext === ".bat";
  const keys = Object.keys(env);
  const filled = await fillToolSecretTexts(
    [...args, ...keys.map((key) => env[key]!)],
    names,
    source,
    // The environment is never parsed by a shell.
    { shell: (index) => viaCmd && index < args.length },
  );
  if (!filled.ok) return filled;
  const outEnv: Record<string, string> = {};
  for (const [index, key] of keys.entries()) outEnv[key] = filled.texts[args.length + index]!;
  return { ok: true, args: filled.texts.slice(0, args.length), env: outEnv };
}
