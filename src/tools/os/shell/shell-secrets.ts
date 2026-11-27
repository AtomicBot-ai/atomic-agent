import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import {
  secretPlaceholderNames,
  substituteSecretPlaceholders,
} from "../../../sandbox/secret-placeholders.js";

/**
 * `{{secret:NAME}}` in `os.shell.run` (ATO-476). Two steps around the
 * approval: {@link checkShellSecrets} before it (every name must be a
 * configured tool secret, so a call that cannot run is never offered for
 * approval) and {@link fillShellSecrets} after it (values fetched and
 * substituted into the argv that is spawned, never into the call the
 * transcript, the trace or the approval card shows).
 */

export type ShellSecretCheck = { ok: true; names: string[] } | { ok: false; message: string };

export function checkShellSecrets(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  source: ToolSecretSource | undefined,
): ShellSecretCheck {
  let names: string[];
  try {
    names = secretPlaceholderNames([cmd, ...execArgs]);
  } catch (err) {
    return { ok: false, message: messageOf(err) };
  }
  if (names.length === 0) return { ok: true, names };
  // The program itself stays something the guard and the human saw.
  if (!useShell && secretPlaceholderNames([cmd]).length > 0) {
    return { ok: false, message: "a secret placeholder cannot be the program name; put it in args" };
  }
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

/** The approval reason's tail: which secrets the human is letting the command use. */
export function describeShellSecretUse(names: readonly string[]): string {
  if (names.length === 0) return "";
  return ` (uses secret${names.length === 1 ? "" : "s"} ${names.join(", ")}: filled in when it starts, masked in output (exact value))`;
}

export type ShellSecretFill =
  | { ok: true; cmd: string; args: string[] }
  | { ok: false; message: string };

/**
 * `cmd` and `execArgs` with every placeholder replaced by its value.
 * `sameVerdict` re-runs the command guard on the filled command: a value
 * that would make the guard read the command differently (a different
 * rule) refuses the call, so the approval always covered what runs.
 */
export async function fillShellSecrets(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  names: readonly string[],
  source: ToolSecretSource,
  sameVerdict: (cmd: string, args: readonly string[]) => boolean,
): Promise<ShellSecretFill> {
  const values = new Map<string, string>();
  try {
    for (const name of names) values.set(name, await source.resolve(name));
    const filledCmd = substituteSecretPlaceholders(cmd, values, { shell: useShell });
    const filledArgs = execArgs.map((arg) => substituteSecretPlaceholders(arg, values, { shell: useShell }));
    if (!sameVerdict(filledCmd, filledArgs)) {
      return {
        ok: false,
        message: "the command reads differently to the shell guard once its secrets are filled in, so it is not run",
      };
    }
    return { ok: true, cmd: filledCmd, args: filledArgs };
  } catch (err) {
    return { ok: false, message: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
