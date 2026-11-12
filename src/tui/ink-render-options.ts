/**
 * The options the TUI hands Ink's `render()`.
 *
 * Split out of `tui-command.ts` so each choice below can be asserted
 * without booting the runtime: here it is a pure function returning a
 * plain object.
 *
 * That is a convenience, not the only way to see these options. The
 * options actually handed to `render()` are asserted end-to-end in
 * `tui-command.mouse.test.ts`, which boots `tuiCommand` with `node:sea`
 * stubbed and Ink's `render` intercepted. Keep that assertion: a unit
 * test of this function says nothing about whether the call site still
 * calls it.
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

/**
 * Whether Ink repaints only the lines that changed. Flip to `false` to
 * go back to full-frame repaints; nothing else depends on it.
 *
 * On since Ink 8 (ATO-648). Ink's `incrementalRendering` writes only
 * the lines whose rendered string differs from the previous frame's,
 * and since 8.0.0 only the changed tail of each such line. The default
 * erases and rewrites every line of the frame, several times a second
 * while a turn runs, which a terminal without DEC 2026 synchronized
 * output paints as a blink.
 *
 * It was off under Ink 7 because the diff anchor did not survive a
 * session swap. Driven over a PTY at 120x34 into a pyte grid, counting
 * the cells that carry a non-default background (the sidebar's fill
 * and the composer's frame) before and after `ctrl+g n`:
 *
 *   painted rows          before the swap   after the swap
 *   incremental: true          33                 1
 *   incremental: false         33                33
 *
 * The renderer believed lines it never repainted were still where it
 * left them; `instance.clear()` on the session change did not resync
 * it. Ink 8.0.0 rewrote that path (vadimdemedes/ink#1036, #1039: fixes
 * for single-line updates, new blank rows and changed rows, plus a
 * redraw when the terminal loses rows). That swap measurement has to
 * be repeated on the new renderer before release; if the rail fill is
 * lost again, set this back to `false`.
 *
 * Not tied to this flag: the elapsed-time tick in `ThinkingIndicator`
 * stays at 1000 ms either way.
 */
export const INCREMENTAL_RENDERING = true;

export function buildInkRenderOptions(
  input: InkRenderOptionsInput,
): RenderOptions {
  return {
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    exitOnCtrlC: false,
    incrementalRendering: INCREMENTAL_RENDERING,
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
