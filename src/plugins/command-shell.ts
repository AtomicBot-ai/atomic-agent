import { randomBytes } from "node:crypto";

/**
 * Shell lines in the operator's own slash commands (ATO-2441):
 * `` !`git diff` `` (Claude Code) and `!{git diff}` (Gemini CLI). When the
 * command is invoked, each one runs through `os.shell.run` with the
 * normal approval at dispatch (`command-shell-runner.ts`), and its output
 * takes its place in the message. Nothing runs when the palette lists
 * the command, and a refused or failed line stops the whole message.
 *
 * The lines are cut out of the body before the arguments are filled in,
 * so text that came from `$ARGUMENTS` never becomes a shell line itself;
 * the arguments still fill `$1`.. inside a line, as in Claude Code.
 */
export interface ShellSlot {
  /** Stands in the rendered text where the output goes. */
  marker: string;
  /** The line as written in the file, before `$ARGUMENTS` / `$1` are filled. */
  command: string;
}

/** Runs one line and returns its output; throws `CommandShellRefused` when it did not run or failed. */
export type CommandShellRunner = (command: string) => Promise<string>;

/** A shell line of a command that was not allowed, refused or failed. The message is for the person. */
export class CommandShellRefused extends Error {
  constructor(public readonly command: string, public readonly why: string) {
    super(`\`${command}\` ${why}`);
    this.name = "CommandShellRefused";
  }
}

export const MAX_SHELL_LINES = 10;
export const MAX_SHELL_OUTPUT_CHARS = 16_000;
const MAX_COMMAND_CHARS = 2_000;

/**
 * Cut every shell line out of `body`, leaving a marker per line. A
 * `!{` without its closing brace, an empty line and a backtick span that
 * crosses a line break stay as written. More than `MAX_SHELL_LINES`
 * lines is refused: a template is not a script.
 */
export function extractShellSlots(body: string, nonce = randomBytes(6).toString("hex")): { body: string; slots: ShellSlot[] } {
  const slots: ShellSlot[] = [];
  let out = "";
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf("!", i);
    if (at === -1) break;
    const span = readShellSpan(body, at);
    if (span === null) {
      out += body.slice(i, at + 1);
      i = at + 1;
      continue;
    }
    if (slots.length >= MAX_SHELL_LINES) throw new Error(`a command may run at most ${MAX_SHELL_LINES} shell lines`);
    const marker = `⟦atag-shell-${nonce}-${slots.length}⟧`;
    slots.push({ marker, command: span.command });
    out += body.slice(i, at) + marker;
    i = span.end;
  }
  return { body: out + body.slice(i), slots };
}

/** The shell line starting at `body[at] === "!"`, or null when there is none. */
function readShellSpan(body: string, at: number): { command: string; end: number } | null {
  const open = body[at + 1];
  if (open === "`") {
    const close = body.indexOf("`", at + 2);
    if (close === -1) return null;
    const command = body.slice(at + 2, close);
    return usable(command) ? { command: command.trim(), end: close + 1 } : null;
  }
  if (open === "{") {
    let depth = 0;
    for (let j = at + 1; j < body.length; j++) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}" && --depth === 0) {
        const command = body.slice(at + 2, j);
        return usable(command) ? { command: command.trim(), end: j + 1 } : null;
      }
    }
  }
  return null;
}

function usable(command: string): boolean {
  return command.trim().length > 0 && !/[\r\n]/.test(command.trim()) && command.length <= MAX_COMMAND_CHARS;
}

/**
 * Run each slot in order and put its output where its marker stands.
 * `fill` turns the written line into the line that runs (arguments
 * filled in). The first line that throws stops the rest: nothing after
 * it runs and no message is sent.
 */
export async function fillShellSlots(
  text: string,
  slots: readonly ShellSlot[],
  run: CommandShellRunner,
  fill: (command: string) => string = command => command,
): Promise<string> {
  let out = text;
  for (const slot of slots) {
    const command = fill(slot.command).trim();
    if (command.length === 0) throw new CommandShellRefused(slot.command, "is empty once the arguments are filled in");
    const output = clipOutput((await run(command)).replace(/\r\n/g, "\n").trimEnd());
    out = out.split(slot.marker).join(output);
  }
  return out;
}

function clipOutput(output: string): string {
  if (output.length <= MAX_SHELL_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n[output cut at ${MAX_SHELL_OUTPUT_CHARS} characters]`;
}
