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
  /** Environment to read `INCREMENTAL_RENDERING_ENV` from; `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Whether Ink repaints only the lines that changed. Flip to `true` to
 * turn it on; nothing else depends on it.
 *
 * Off until the session-swap measurement below passes on Ink 8 (run it
 * on the second Mac, `scripts/tui-session-swap-paint.py`). Ink's
 * `incrementalRendering` writes only the lines whose rendered string
 * differs from the previous frame's, and since 8.0.0 only the changed
 * tail of each such line. The default erases and rewrites every line of
 * the frame, several times a second while a turn runs, which a terminal
 * without DEC 2026 synchronized output paints as a blink.
 *
 * It was turned off under Ink 7 because the diff anchor did not survive
 * a session swap. Driven over a PTY at 120x34 into a pyte grid,
 * counting the rows that carry a non-default background (the sidebar's
 * fill and the composer's frame) before and after `ctrl+g n`:
 *
 *   painted rows          before the swap   after the swap
 *   incremental: true          33                 1
 *   incremental: false         33                33
 *
 * The renderer believed lines it never repainted were still where it
 * left them; `instance.clear()` on the session change did not resync
 * it. Ink 8.0.0 rewrote that path (vadimdemedes/ink#1036, #1039), but
 * nobody has repeated the measurement on it yet. When the script prints
 * 33/33 with incremental rendering forced on, flip this to `true`.
 *
 * Not tied to this flag: the elapsed-time tick in `ThinkingIndicator`
 * stays at 1000 ms either way.
 */
export const INCREMENTAL_RENDERING = false;

/**
 * Set to `1` to force incremental rendering on for one run, whatever
 * `INCREMENTAL_RENDERING` says. Exists for the session-swap measurement
 * above; not a user setting, and read nowhere else.
 */
export const INCREMENTAL_RENDERING_ENV = "ATOMIC_AGENT_INK_INCREMENTAL";

export function incrementalRenderingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[INCREMENTAL_RENDERING_ENV] === "1" || INCREMENTAL_RENDERING;
}

export function buildInkRenderOptions(
  input: InkRenderOptionsInput,
): RenderOptions {
  return {
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
    exitOnCtrlC: false,
    incrementalRendering: incrementalRenderingEnabled(input.env),
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
