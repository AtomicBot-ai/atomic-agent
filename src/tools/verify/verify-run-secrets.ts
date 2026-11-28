import type { ToolSecretSource } from "../../config/tool-secrets.js";
import { secretPlaceholderNames } from "../../sandbox/secret-placeholders.js";
import { checkToolSecretNames, fillToolSecretTexts, type ToolSecretCheck } from "../tool-secret-use.js";
import { needsShellInterpretation } from "../os/shell/shell-interpretation.js";
import type { VerifyRunArgs } from "./verify-run-args.js";
import { verifyRunCommands } from "./verify-run-guard.js";

/**
 * `{{secret:NAME}}` in `verify.run` (ATO-2530): in the command it starts
 * (`cmd`/`args`, or `start.cmd`/`start.args`) and in `env`. Same
 * contract as `os.shell.run`: known names before the approval, values
 * after it, only into what is spawned; the preview, the result and every
 * record keep the placeholders.
 */

/** Every text a placeholder is filled into: the commands, then the env values. */
function secretTexts(args: VerifyRunArgs): string[] {
  return [
    ...verifyRunCommands(args).flatMap((command) => [command.cmd, ...command.args]),
    ...Object.values(args.env ?? {}),
  ];
}

export function checkVerifySecrets(
  args: VerifyRunArgs,
  source: ToolSecretSource | undefined,
): ToolSecretCheck {
  const check = checkToolSecretNames(secretTexts(args), source);
  if (!check.ok || check.names.length === 0) return check;
  // The program itself stays something the guard and the human saw.
  for (const command of verifyRunCommands(args)) {
    if (!needsShellInterpretation(command.cmd, command.args) && secretPlaceholderNames([command.cmd]).length > 0) {
      return { ok: false, message: "a secret placeholder cannot be the program name; put it in args" };
    }
  }
  return check;
}

export type VerifySecretFill = { ok: true; args: VerifyRunArgs } | { ok: false; message: string };

/**
 * `args` with the values filled in. A command line a shell reads takes
 * only plain token characters. `sameVerdict` re-runs the shell guard on
 * each filled command; a filled command that would be read another way
 * (another guard rule, or a subshell where there was none) is refused,
 * so the approval covered what runs.
 */
export async function fillVerifySecrets(
  args: VerifyRunArgs,
  names: readonly string[],
  source: ToolSecretSource,
  sameVerdict: (before: { cmd: string; args: readonly string[] }, after: { cmd: string; args: readonly string[] }) => boolean,
): Promise<VerifySecretFill> {
  const commands = verifyRunCommands(args);
  const shellAt: boolean[] = [];
  for (const command of commands) {
    const viaShell = needsShellInterpretation(command.cmd, command.args);
    shellAt.push(viaShell, ...command.args.map(() => viaShell));
  }
  const filled = await fillToolSecretTexts(secretTexts(args), names, source, {
    // The environment is never parsed by a shell.
    shell: (index) => shellAt[index] === true,
  });
  if (!filled.ok) return filled;
  let at = 0;
  const filledCommands = commands.map((command) => {
    const cmd = filled.texts[at++]!;
    const cmdArgs = command.args.map(() => filled.texts[at++]!);
    return { cmd, args: cmdArgs };
  });
  for (const [index, command] of commands.entries()) {
    const after = filledCommands[index]!;
    if (
      needsShellInterpretation(after.cmd, after.args) !== needsShellInterpretation(command.cmd, command.args) ||
      !sameVerdict(command, after)
    ) {
      return {
        ok: false,
        message: "the command reads differently to the shell guard once its secrets are filled in, so it is not run",
      };
    }
  }
  const envKeys = Object.keys(args.env ?? {});
  const env = Object.fromEntries(envKeys.map((key) => [key, filled.texts[at++]!]));
  const first = filledCommands[0];
  const out: VerifyRunArgs =
    args.kind === "command"
      ? { ...args, ...(first === undefined ? {} : { cmd: first.cmd, args: first.args }) }
      : { ...args, ...(first === undefined || args.start === undefined ? {} : { start: { ...args.start, cmd: first.cmd, args: first.args } }) };
  return { ok: true, args: args.env === undefined ? out : { ...out, env } };
}

/**
 * `result` with the filled command line put back as the model wrote it
 * (placeholders), in the fields that echo it: `commandLine`, `error` and
 * `summary`. What the command printed is masked by exact value on the
 * way to the model (`tool-output-secrets.ts`).
 */
export function withPlaceholderCommandLine<T extends { readonly summary: string; readonly commandLine?: string; readonly error?: string }>(
  result: T,
  written: VerifyRunArgs,
  filled: VerifyRunArgs,
): T {
  const shown = verifyRunCommands(written)[0];
  const ran = verifyRunCommands(filled)[0];
  if (shown === undefined || ran === undefined) return result;
  const from = [ran.cmd, ...ran.args].join(" ");
  const to = [shown.cmd, ...shown.args].join(" ");
  if (from === to) return result;
  const put = (text: string): string => text.split(from).join(to);
  return {
    ...result,
    summary: put(result.summary),
    ...(result.commandLine === undefined ? {} : { commandLine: put(result.commandLine) }),
    ...(result.error === undefined ? {} : { error: put(result.error) }),
  };
}
