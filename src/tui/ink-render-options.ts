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

export function buildInkRenderOptions(
  input: InkRenderOptionsInput,
): RenderOptions {
  return {
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    exitOnCtrlC: false,
    // Full-frame repaints, deliberately.
    //
    // Ink's `incrementalRendering` writes only the lines whose rendered
    // string differs from the previous frame's, and anchors that diff
    // by counting rows up from the bottom of the last block
    // (`cursorUp(previousLines.length - 1)` in ink/log-update). It was
    // switched on for the blink it removes — the default erases and
    // rewrites every line of the frame, several times a second while a
    // turn runs, which a terminal without DEC 2026 synchronized output
    // paints.
    //
    // It is off again because the anchor does not survive a session
    // swap. Driven over a PTY at 120x34 into a pyte grid, counting the
    // cells that carry a non-default background — the sidebar's fill
    // and the composer's frame — before and after `ctrl+g n`:
    //
    //   painted rows          before the swap   after the swap
    //   incremental: true          33                 1
    //   incremental: false         33                33
    //
    // The rail's background stops being drawn, and the rows it used to
    // own keep the fill under the composer. Both are the same fault:
    // the renderer believes lines it never repainted are still where it
    // left them, and after a swap they are not — the transcript, the
    // rail and the meta bar are all replaced in one commit.
    //
    // `instance.clear()` on the session change was tried first, so the
    // next frame would be written against an empty cache. It fires (the
    // callback was instrumented to prove it) and the screen is still
    // wrong, so the desync is not something the app can resync from
    // above. The option is Ink's, marked experimental, and the honest
    // place to turn it off is here.
    //
    // What is NOT reverted with it: the elapsed-time tick in
    // `ThinkingIndicator` stays at 1000 ms. That was three of every four
    // wake-ups producing the identical string, and it is the larger
    // share of the repaints a running turn asked for.
    incrementalRendering: false,
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
