/**
 * The options the TUI hands Ink's `render()`.
 *
 * Split out of `tui-command.ts` so the choices below are assertable: that
 * file pulls in the whole runtime (and `node:sea`, which vitest cannot
 * load), so anything asserted about it there has to be asserted by
 * reading source text. Here it is a pure function returning a plain
 * object.
 */
import type { RenderOptions } from "ink";

export interface InkRenderOptionsInput {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  /**
   * Whether the terminal answered the kitty-keyboard query. Enables the
   * protocol only when we know it is understood.
   */
  readonly kittyKeyboard: boolean;
}

export function buildInkRenderOptions(
  input: InkRenderOptionsInput,
): RenderOptions {
  return {
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    exitOnCtrlC: false,
    // Repaint only the lines that changed.
    //
    // Ink's default rewrites the entire frame on every state change:
    // erase every line, print every line, for a screenful of rows. While
    // a turn is running the spinner alone asks for that eight times a
    // second — measured over a PTY, ~9.3 KB and a full-screen erase per
    // frame, 4.3 MB across a one-minute turn. On a terminal that
    // implements DEC 2026 synchronized output the erase is hidden; on one
    // that does not (Apple Terminal among them) it is painted, and the UI
    // visibly blinks. With incremental rendering an unchanged line is
    // skipped instead of rewritten, so a spinner tick costs the spinner's
    // line.
    //
    // Ink marks the mode experimental, so the frame it produces was
    // checked rather than assumed: driven over a PTY into a pyte grid and
    // compared character for character against the default renderer
    // across startup, streaming, the Esc menu, a popup, the composer and
    // a resize. The two ways an incremental renderer can desynchronise
    // from the screen are both already covered — Ink re-syncs its line
    // cache through `log.clear()`/`log.sync()` on the console-passthrough
    // and shrink-resize paths, and this app writes its own escape
    // sequences (alt screen, mouse tracking) only outside a rendered
    // block.
    incrementalRendering: true,
    // `disambiguateEscapeCodes` alone: it is what makes Shift+Enter a
    // distinct keystroke (`ESC [ 13 ; 2 u`). `reportAllKeysAsEscapeCodes`
    // would reroute ordinary typing through CSI u as well, putting the
    // paste and text-insert paths at risk for nothing.
    //
    // `mode: "enabled"` rather than `"auto"`: Ink's own probe and the
    // App's reader both see the terminal's reply, so auto can type
    // `[?1u` into the composer before the first render. The caller
    // already asked, on a stdin nobody else was reading.
    ...(input.kittyKeyboard
      ? {
          kittyKeyboard: {
            mode: "enabled" as const,
            flags: ["disambiguateEscapeCodes" as const],
          },
        }
      : {}),
  };
}
