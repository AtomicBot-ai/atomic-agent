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
    // Repaint only the lines that changed.
    //
    // Ink's default rewrites the entire frame on every state change:
    // erase every line, print every line, for a screenful of rows. While
    // a turn is running the spinner alone asks for that eight to ten
    // times a second — measured over a PTY at 110x34, a median 5.5 KB
    // and a full-screen erase per frame, ~3.4 MB a minute. With this on,
    // the median frame is 237 bytes. On a terminal that
    // implements DEC 2026 synchronized output the erase is hidden; on one
    // that does not (Apple Terminal among them) it is painted, and the UI
    // visibly blinks. With incremental rendering an unchanged line is
    // skipped instead of rewritten, so a spinner tick costs the spinner's
    // line.
    //
    // Ink marks the mode experimental, so the frame it produces was
    // checked rather than assumed: driven over a PTY into a pyte grid and
    // compared character for character against the default renderer, at
    // 110x34, 80x24 and 40x16, across startup, the composer, a turn in
    // flight, the Esc menu and its submenus, every Manage tab, the
    // session and model pickers, the update modal, a mouse drag and
    // wheel, a chat log scrolled past the viewport, resizes that grow and
    // shrink in each dimension separately, and teardown — where the last
    // bytes on the wire (ESU, cursor, mouse, alt screen) are identical
    // byte for byte.
    //
    // The two ways an incremental renderer can desynchronise from the
    // screen are both covered — Ink re-syncs its line cache through
    // `log.clear()`/`log.sync()` on the console-passthrough, width-shrink
    // and clear-terminal paths (a height shrink reaches the last of those
    // via `shouldClearTerminalForFrame`), and this app writes its own
    // escape sequences (alt screen, mouse tracking) only outside a
    // rendered block.
    //
    // Not covered, because the harness cannot reach a provider: assistant
    // text streaming into the transcript, and the approval modal. The
    // closest reachable stand-ins — slash-command output overflowing the
    // viewport, and the update modal — were driven and matched.
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
