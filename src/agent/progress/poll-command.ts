/**
 * Is an `os.shell.run` call a deliberate poll: a call whose whole point
 * is to let time pass and look again?
 *
 * Two shapes qualify. The job forms `{wait: <id>}` and `{jobs: true}`
 * ask about a background job the session already started. A command
 * line that sleeps (`sleep 30 && tail -5 build.log`, PowerShell
 * `Start-Sleep`, Windows `timeout /t 30`) waits on purpose before it
 * looks. Both are how an overnight turn watches a long build, a
 * download or a training run, and both can honestly return the same
 * answer many times in a row while the thing they watch is still busy.
 *
 * Deliberately narrow: a bare `npm test` or `git status` is NOT a poll,
 * however often it runs. A sleep of zero is not a wait either.
 */
const SLEEP_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;&|(])sleep\s+(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*)[smhd]?(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(])start-sleep\b[^;&|]*?\b0*[1-9]\d*/i,
  /(?:^|[\s;&|(])timeout\s+\/t\s+0*[1-9]\d*/i,
];

export function isDeliberatePoll(tool: string, args: unknown): boolean {
  if (tool !== "os.shell.run") return false;
  if (args === null || typeof args !== "object") return false;
  const record = args as Record<string, unknown>;
  if (isPresent(record.wait) || record.jobs === true) return true;
  const line = commandLineOf(record);
  return line !== null && SLEEP_PATTERNS.some((pattern) => pattern.test(line));
}

/** The command line as one string, from `cmd` (string or argv) plus `args`. */
function commandLineOf(record: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const cmd = record.cmd;
  if (typeof cmd === "string") parts.push(cmd);
  else if (Array.isArray(cmd)) parts.push(...cmd.filter(isString));
  if (Array.isArray(record.args)) parts.push(...record.args.filter(isString));
  return parts.length === 0 ? null : parts.join(" ").trim();
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
