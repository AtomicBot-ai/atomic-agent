import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import {
  secretPlaceholderNames,
  substituteSecretPlaceholders,
} from "../../../sandbox/secret-placeholders.js";
import {
  checkToolSecretNames,
  describeToolSecretUse,
  resolveToolSecrets,
  type ToolSecretCheck,
} from "../../tool-secret-use.js";

/**
 * `{{secret:NAME}}` in `os.shell.run` (ATO-476). Two steps around the
 * approval: {@link checkShellSecrets} before it (every name must be a
 * configured tool secret, so a call that cannot run is never offered for
 * approval) and {@link fillShellSecrets} after it (values fetched and
 * substituted into the argv that is spawned, never into the call the
 * transcript, the trace or the approval card shows).
 */

export type ShellSecretCheck = ToolSecretCheck;

export function checkShellSecrets(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  source: ToolSecretSource | undefined,
): ShellSecretCheck {
  const check = checkToolSecretNames([cmd, ...execArgs], source);
  if (!check.ok || check.names.length === 0) return check;
  // The program itself stays something the guard and the human saw.
  if (!useShell && secretPlaceholderNames([cmd]).length > 0) {
    return { ok: false, message: "a secret placeholder cannot be the program name; put it in args" };
  }
  return check;
}

/** The approval reason's tail: which secrets the human is letting the command use. */
export function describeShellSecretUse(names: readonly string[]): string {
  return describeToolSecretUse(names);
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
  try {
    const values = await resolveToolSecrets(names, source);
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
