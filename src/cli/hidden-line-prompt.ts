/**
 * Read one line from a terminal without echoing it (ATO-2756), for
 * `config secrets set NAME`. Precedent: `npm login`, `gh auth login`,
 * Codex `login --api-key`: a prompt on stderr, nothing shown while the
 * user types or pastes, Enter finishes, Ctrl+C cancels.
 *
 * Raw mode turns the terminal's own echo off on macOS, Linux and
 * Windows alike (`tty.ReadStream.setRawMode`), so the value never lands
 * in the scrollback. The caller decides when the input is a terminal;
 * a pipe keeps the plain stdin read so scripts and the desktop app work
 * as before.
 */

export interface RawModeInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/** Whether `input` is a terminal this prompt can switch to raw mode. */
export function isRawModeTerminal(input: NodeJS.ReadableStream): boolean {
  const candidate = input as RawModeInput;
  return candidate.isTTY === true && typeof candidate.setRawMode === "function";
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);
/** Escape sequences (arrow keys, bracketed-paste markers): never part of a value. */
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[~A-Za-z]|\u001b./g;

/**
 * Print `prompt` on `output`, read one line from `input` with echo off,
 * and resolve with it; null when the user pressed Ctrl+C. Backspace
 * removes the last character; other control characters are ignored.
 */
export function readHiddenLine(
  input: RawModeInput,
  output: { write(chunk: string): unknown },
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let value = "";
    output.write(prompt);
    input.setRawMode?.(true);
    input.setEncoding("utf8");

    const finish = (result: string | null): void => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      // Echo is off, so the user's Enter did not move the cursor.
      output.write("\n");
      resolve(result);
    };

    const onData = (chunk: string | Buffer): void => {
      const text = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).replace(ESCAPE_SEQUENCE, "");
      for (const ch of text) {
        if (ch === CTRL_C) {
          finish(null);
          return;
        }
        if (ch === "\r" || ch === "\n" || ch === CTRL_D) {
          finish(value);
          return;
        }
        if (BACKSPACE.has(ch)) {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (ch < " ") continue;
        value += ch;
      }
    };

    input.on("data", onData);
    input.resume();
  });
}
