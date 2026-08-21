/**
 * Whether Shift+Enter reaches the app as a distinct keystroke.
 *
 * In the legacy terminal encoding it does not: Enter and Shift+Enter are
 * both a bare `\r`, so the composer cannot tell them apart and the
 * modifier means nothing. Under the kitty keyboard protocol it arrives
 * as `ESC [ 13 ; 2 u` and does.
 *
 * `tui-command` probes for the protocol at startup and sets this once.
 * The hint strip reads it so the newline chip names the key that will
 * actually work — advertising Shift+Enter where Enter is indistinguishable
 * would send a half-written message the first time someone believed it.
 */
let shiftEnterNewline = false;

export function setShiftEnterNewline(supported: boolean): void {
  shiftEnterNewline = supported;
}

export function hasShiftEnterNewline(): boolean {
  return shiftEnterNewline;
}
