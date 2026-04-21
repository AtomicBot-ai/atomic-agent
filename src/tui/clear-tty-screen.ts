/**
 * Clears the visible terminal viewport and moves the cursor to the home
 * position. Used when the chat transcript is discarded but Ink `<Static>`
 * lines would otherwise remain painted (e.g. `/new`).
 *
 * No-op when stdout is not a TTY (pipes, CI).
 */
const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";

export function clearTtyScreen(stdout: NodeJS.WriteStream = process.stdout): void {
  if (stdout.isTTY !== true) return;
  stdout.write(CLEAR_SCREEN_AND_HOME);
}
