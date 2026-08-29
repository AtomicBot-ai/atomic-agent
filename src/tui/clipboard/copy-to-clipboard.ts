/**
 * Writing to the *user's* clipboard from a TUI.
 *
 * There is no single mechanism that works everywhere, and the two that
 * exist fail in exactly opposite situations — so this module runs both
 * and reports success if either one landed.
 *
 *   - **OSC 52** (`ESC ] 52 ; c ; <base64> BEL`) asks the terminal
 *     emulator itself to set the clipboard. It is the only mechanism
 *     that survives SSH: the bytes travel back up the same pty the
 *     frames come down, so the text lands on the machine the human is
 *     sitting at rather than on the box the agent happens to run on.
 *     Its weakness is that it is advisory — the terminal may ignore it
 *     (Apple Terminal does), gate it behind a preference (iTerm2's
 *     "Applications in terminal may access clipboard"), or swallow it
 *     in a multiplexer (tmux needs `set -g set-clipboard on`; GNU screen
 *     needs DCS wrapping we do not emit). Crucially, **there is no
 *     reply**: a terminal that ignores 52 is indistinguishable from one
 *     that honoured it, so we can never report "OSC 52 worked".
 *   - **The platform clipboard command** (`pbcopy`, `wl-copy`, `xclip`,
 *     `clip.exe`) is authoritative — it either exits 0 or it does not —
 *     but it writes to the clipboard of the machine the *process* runs
 *     on, which is the wrong machine over SSH, and it does not exist at
 *     all on a headless box.
 *
 * Doing both is not belt-and-braces sloppiness; it is the only way to
 * cover Apple Terminal (native only) and a remote session (OSC 52 only)
 * with one code path. Writing the same string twice is harmless: the
 * clipboard ends up holding that string either way.
 *
 * Safety of interleaving OSC 52 with Ink's frames: the sequence moves no
 * cursor, sets no mode, and paints no cell, so a terminal that
 * understands it consumes it invisibly wherever it lands between Ink's
 * writes, and one that does not silently drops an unknown OSC. That is
 * why it can be written straight to the same stdout Ink is rendering to
 * without coordinating with the renderer or leaving the alt screen.
 *
 * Everything the writer touches — stdout, process spawning, platform,
 * env — is injected, so tests exercise the real decision logic without
 * going anywhere near the developer's actual clipboard.
 */
import { spawn } from "node:child_process";

export interface ClipboardWriter {
  /**
   * Copies `text`. Resolves `true` when at least one mechanism is
   * believed to have worked — see {@link createClipboardWriter} for what
   * "believed" can and cannot mean.
   */
  copy(text: string): Promise<boolean>;
}

/** Minimal shape of the stream OSC 52 is written to. */
export interface ClipboardStdout {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

/** Runs a clipboard command with `text` on stdin; resolves `true` on exit 0. */
export type ClipboardCommandRunner = (
  command: string,
  args: readonly string[],
  text: string,
) => Promise<boolean>;

export interface ClipboardWriterOptions {
  readonly stdout?: ClipboardStdout;
  readonly runCommand?: ClipboardCommandRunner;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Terminals differ on how much base64 they will accept in one OSC 52,
 * and the ones that dislike a long payload tend to drop it *silently*
 * rather than truncate — which would leave the user with a stale
 * clipboard and a cheerful "copied!". Past this size we skip OSC 52 and
 * let the platform command carry the copy alone; a paste that big is
 * overwhelmingly a local one anyway.
 */
export const OSC52_MAX_BASE64_CHARS = 100_000;

/** BEL terminator: accepted everywhere `ESC \` is, and by a few terminals that mis-parse ST. */
const BEL = "\u0007";

/** The OSC 52 sequence that sets the system clipboard (`c`) to `text`. */
export function osc52Sequence(text: string): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  return `\u001B]52;c;${payload}${BEL}`;
}

/** `true` when `text` is small enough to be worth sending as OSC 52. */
export function fitsInOsc52(text: string): boolean {
  // 4 base64 chars per 3 input bytes, rounded up — cheaper than encoding
  // a megabyte of transcript just to find out it is too big.
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 3) * 4 <= OSC52_MAX_BASE64_CHARS;
}

/**
 * The platform's clipboard command, or `null` when there is none worth
 * trying. On Linux the answer depends on the *session*, not the OS:
 * `wl-copy` under Wayland, `xclip` under X11, and nothing at all on a
 * headless box — where returning `null` is the honest answer and OSC 52
 * is the only route back to the human's clipboard.
 */
export function platformClipboardCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): ClipboardCommand | null {
  if (platform === "darwin") return { command: "pbcopy", args: [] };
  if (platform === "win32") return { command: "clip", args: [] };
  if (env.WAYLAND_DISPLAY) return { command: "wl-copy", args: [] };
  if (env.DISPLAY) {
    return { command: "xclip", args: ["-selection", "clipboard"] };
  }
  return null;
}

/**
 * Default runner: spawns the command, feeds `text` on stdin, resolves on
 * the exit code. A missing binary surfaces as an `error` event rather
 * than a non-zero exit, so both collapse to `false` — the caller only
 * ever needs "did the clipboard change".
 */
const spawnClipboardCommand: ClipboardCommandRunner = (
  command,
  args,
  text,
) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
      // EPIPE here means the child died before reading — `close` already
      // has that case covered, so the write error is not interesting.
      child.stdin?.on("error", () => {});
      child.stdin?.end(text);
    } catch {
      done(false);
    }
  });

/**
 * Builds the clipboard writer used by the TUI.
 *
 * `copy` resolves `true` if the platform command succeeded, **or** if we
 * emitted OSC 52 to a TTY. The second half is optimism, and deliberately
 * so: OSC 52 never answers, so the alternative is to report failure on
 * every terminal that only supports OSC 52 (i.e. every SSH session),
 * which would be wrong far more often than the optimism is. A stale
 * clipboard is recoverable; a "copy failed" badge on a copy that worked
 * teaches the user the button is broken.
 *
 * When stdout is not a TTY nothing is attempted at all. There is no
 * terminal to talk to, and — the reason this guard matters in practice —
 * it keeps every non-interactive run, the test suite included, from
 * reaching out and overwriting a real human's clipboard.
 */
export function createClipboardWriter(
  options: ClipboardWriterOptions = {},
): ClipboardWriter {
  const stdout = options.stdout ?? process.stdout;
  const runCommand = options.runCommand ?? spawnClipboardCommand;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return {
    async copy(text: string): Promise<boolean> {
      if (stdout.isTTY !== true) return false;
      let claimed = false;
      if (fitsInOsc52(text)) {
        try {
          stdout.write(osc52Sequence(text));
          claimed = true;
        } catch {
          // A stdout that rejects a write is a dead terminal; the
          // platform command may still be able to do the job.
        }
      }
      const command = platformClipboardCommand(platform, env);
      if (command) {
        const ok = await runCommand(command.command, command.args, text);
        claimed = claimed || ok;
      }
      return claimed;
    },
  };
}

/**
 * A writer that does nothing and reports failure. Used where a clipboard
 * is structurally unavailable, and as the explicit stand-in in tests
 * that must not touch a real one.
 */
export function createNullClipboardWriter(): ClipboardWriter {
  return { copy: async () => false };
}
