import type { ToolSecretSource } from "../config/tool-secrets.js";
import { rememberResolvedSecret } from "../sandbox/resolved-secret-values.js";
import {
  secretPlaceholderNames,
  substituteSecretPlaceholders,
} from "../sandbox/secret-placeholders.js";

/**
 * The steps every tool that fills in `{{secret:NAME}}` shares (ATO-476,
 * ATO-2530): `os.shell.run`, `os.http.request` headers,
 * `skill.run_script`, `verify.run` and an MCP server's `env`.
 *
 * 1. {@link checkToolSecretNames} before any approval: a malformed
 *    placeholder or a name that is not a configured tool secret fails
 *    the call, so a call that cannot run is never offered.
 * 2. The approval, with the placeholders in the preview and
 *    {@link describeToolSecretUse} in the reason.
 * 3. {@link fillToolSecretTexts} after it: values fetched only now, put
 *    only into what is executed or sent, and remembered for masking.
 */

export type ToolSecretCheck = { ok: true; names: string[] } | { ok: false; message: string };

export function checkToolSecretNames(
  texts: readonly string[],
  source: ToolSecretSource | undefined,
): ToolSecretCheck {
  let names: string[];
  try {
    names = secretPlaceholderNames(texts);
  } catch (err) {
    return { ok: false, message: messageOf(err) };
  }
  if (names.length === 0) return { ok: true, names };
  if (source === undefined) {
    return {
      ok: false,
      message: `unknown secret ${names[0]}: no tool secrets are configured (toolSecrets in secret-sources.json)`,
    };
  }
  const unknown = names.find((name) => !source.has(name));
  if (unknown !== undefined) {
    return { ok: false, message: `unknown secret ${unknown}: it is not listed in toolSecrets of secret-sources.json` };
  }
  return { ok: true, names };
}

/**
 * The approval reason's tail: which secrets the human is letting the
 * call use. `when` says when the value goes in ("when it starts" for a
 * process, "when it is sent" for a request).
 */
export function describeToolSecretUse(names: readonly string[], when = "when it starts"): string {
  if (names.length === 0) return "";
  return ` (uses secret${names.length === 1 ? "" : "s"} ${names.join(", ")}: filled in ${when}, masked in output (exact value))`;
}

/**
 * The value of each name, fetched now. Each one is also remembered for
 * the exact-value masking of tool output, errors and traces, whatever
 * the source did, so what the filled call prints back is masked.
 */
export async function resolveToolSecrets(
  names: readonly string[],
  source: ToolSecretSource,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (const name of names) {
    const value = await source.resolve(name);
    rememberResolvedSecret(name, value);
    values.set(name, value);
  }
  return values;
}

export type ToolSecretFill = { ok: true; texts: string[] } | { ok: false; message: string };

/**
 * `texts` with every placeholder replaced by its value, each value
 * fetched once. `shell` is true for text a shell will parse (or a test
 * per text index). A value holding a NUL is refused: a spawn would fail
 * on it with the value in its error.
 */
export async function fillToolSecretTexts(
  texts: readonly string[],
  names: readonly string[],
  source: ToolSecretSource,
  options: { shell: boolean | ((index: number) => boolean) },
): Promise<ToolSecretFill> {
  try {
    const values = await resolveToolSecrets(names, source);
    for (const [name, value] of values) {
      if (value.includes("\0")) return { ok: false, message: `secret ${name} holds a NUL character, so it is not used` };
    }
    const shellAt = typeof options.shell === "function" ? options.shell : () => options.shell === true;
    return {
      ok: true,
      texts: texts.map((text, index) => substituteSecretPlaceholders(text, values, { shell: shellAt(index) })),
    };
  } catch (err) {
    return { ok: false, message: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
