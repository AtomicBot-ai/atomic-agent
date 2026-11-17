/**
 * Which inline-image protocol, if any, the host terminal speaks (ATO-660).
 *
 * Read from the environment only: a query (kitty's `a=q`, iTerm2's
 * `ReportCellSize`) costs a round trip on a stdin the TUI is already
 * reading, the same reason `alt-screen.ts` and `synchronized-output.ts`
 * do not probe either. A miss is cheap: the card keeps showing the file
 * path, as it always did.
 *
 *   - `kitty`  — kitty (`TERM=xterm-kitty`, `KITTY_WINDOW_ID`) and Ghostty
 *     (`TERM_PROGRAM=ghostty`, `TERM=xterm-ghostty`): the kitty graphics
 *     protocol, including Unicode placeholders.
 *   - `iterm2` — iTerm2 (`TERM_PROGRAM=iTerm.app`, `LC_TERMINAL=iTerm2`)
 *     and WezTerm (`TERM_PROGRAM=WezTerm`): OSC 1337 inline files.
 *
 * Never inside tmux or GNU screen. Both need passthrough configured to
 * forward graphics, and the outer terminal is not knowable from here, so
 * the honest answer there is "no".
 */
export type ImageProtocol = "kitty" | "iterm2";

/** Turns the feature on while it is unverified in live terminals. */
export const INLINE_IMAGES_OPT_IN_ENV = "ATOMIC_AGENT_INLINE_IMAGES";
/** Turns it off whatever else is set; wins over the opt-in. */
export const INLINE_IMAGES_OPT_OUT_ENV = "ATOMIC_AGENT_NO_INLINE_IMAGES";

type Env = Readonly<Record<string, string | undefined>>;

function isSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v.length > 0 && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** `TMUX`, `STY`, or a `TERM` tmux/screen set for the inner shell. */
export function isInsideMultiplexer(env: Env): boolean {
  if (isSet(env["TMUX"]) || isSet(env["STY"])) return true;
  const term = (env["TERM"] ?? "").toLowerCase();
  return term.startsWith("screen") || term.startsWith("tmux");
}

/** The protocol the terminal speaks, ignoring the opt-in / opt-out. */
export function detectImageProtocol(env: Env): ImageProtocol | null {
  if (isInsideMultiplexer(env)) return null;
  const term = (env["TERM"] ?? "").toLowerCase();
  const program = (env["TERM_PROGRAM"] ?? "").toLowerCase();
  if (term === "xterm-kitty" || isSet(env["KITTY_WINDOW_ID"])) return "kitty";
  if (program === "ghostty" || term === "xterm-ghostty") return "kitty";
  if (program === "iterm.app" || env["LC_TERMINAL"] === "iTerm2") return "iterm2";
  if (program === "wezterm") return "iterm2";
  return null;
}

/**
 * The protocol the TUI may use right now: the detected one, only when
 * the operator opted in and did not opt out.
 */
export function resolveImageProtocol(env: Env): ImageProtocol | null {
  if (isSet(env[INLINE_IMAGES_OPT_OUT_ENV])) return null;
  if (!isSet(env[INLINE_IMAGES_OPT_IN_ENV])) return null;
  return detectImageProtocol(env);
}
