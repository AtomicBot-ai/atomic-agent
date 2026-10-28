/**
 * The keys models send for `os.shell.run`'s command instead of `cmd`,
 * read as `cmd` (ATO-1259). `{"command": "…"}` used to come back
 * "unknown argument `command`"; on a cloud model that retried the same
 * key the turn ran out. The intent is not in doubt.
 *
 * Do-no-harm, as for `os.fs.move`'s aliases: nothing is read when `cmd`
 * itself is given (an alias never overrides what the model did say),
 * when two aliases are given, or when the value is not a non-empty
 * string or string list. Every other key is passed through as sent.
 */
const CMD_ALIASES = [
  "command",
  "cmdline",
  "commandLine",
  "command_line",
  "shell_command",
  "shellCommand",
] as const;

export interface ShellAliasReading {
  readonly args: Record<string, unknown>;
  readonly note: string;
}

function commandValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.length > 0)
  );
}

export function readShellAliases(
  args: Record<string, unknown>,
): ShellAliasReading | null {
  const cmd = args.cmd;
  if (cmd !== undefined && cmd !== null && cmd !== "") return null;
  const used = CMD_ALIASES.filter((key) => Object.hasOwn(args, key));
  if (used.length !== 1) return null;
  const key = used[0]!;
  const value = args[key];
  if (!commandValue(value)) return null;
  const out: Record<string, unknown> = { ...args, cmd: value };
  delete out[key];
  return {
    args: out,
    note: `note: read \`${key}\` as \`cmd\`; os.shell.run takes the command in \`cmd\` (e.g. {"cmd":"git status"} or {"cmd":"git","args":["status"]}).`,
  };
}
