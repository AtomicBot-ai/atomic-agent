/**
 * Terminal background autodetection via the OSC 11 query
 * (`ESC ] 11 ; ? BEL`). The terminal replies on stdin with its default
 * background colour; we classify it as dark or light by relative luminance
 * and pick the matching theme before Ink mounts.
 *
 * Modeled on opencode / charm-lipgloss, but deliberately fixes the bugs those
 * implementations ship. Each guarded edge case is annotated `P<n>` to match
 * the plan's pitfall list:
 *
 *  P1  non-TTY guard          P7  luminance on 0..255 (single normalize)
 *  P2  TTY output stream      P8  single-resolve guard
 *  P3  buffer accumulation    P9  raw-mode capture + restore
 *  P4  terminator-gated parse P10 stdin flow-state restore
 *  P5  early-resolve + short  P11 malformed reply -> "unknown"
 *      timeout (no OSC 4)
 *  P6  width-aware hex parse
 */

import { THEMES, type TuiTheme } from "./theme.js";

export type TerminalBackgroundMode = "dark" | "light" | "unknown";

export interface DetectTerminalBackgroundDeps {
  /** Input stream the terminal replies on. Defaults to `process.stdin`. */
  readonly stdin?: NodeJS.ReadStream;
  /** Preferred query output stream. Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WriteStream;
  /** Fallback query output stream. Defaults to `process.stderr`. */
  readonly stderr?: NodeJS.WriteStream;
  /** Fallback timeout in ms before giving up. Default 150. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 150;

// OSC 11 reply: `ESC ] 11 ; <color> (BEL | ST)`. The `<color>` group is
// terminator-gated (P4) so a truncated, still-streaming reply does not match.
const OSC11_REPLY = /\x1b\]11;(rgb:[^\x07\x1b]+|#[0-9a-fA-F]+)(?:\x07|\x1b\\)/;

const OSC11_QUERY = "\x1b]11;?\x07";

/**
 * Probe the terminal background colour. Resolves to `"dark"`, `"light"`, or
 * `"unknown"` (non-TTY, no reply, timeout, or unparseable). Never throws.
 */
export function detectTerminalBackground(
  deps: DetectTerminalBackgroundDeps = {},
): Promise<TerminalBackgroundMode> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // P1: never touch raw mode when stdin is not a TTY (CI / pipe).
  if (!stdin.isTTY) return Promise.resolve("unknown");

  // P2: the query must reach the terminal — pick a TTY output stream.
  const out: NodeJS.WriteStream | null = stdout.isTTY
    ? stdout
    : stderr.isTTY
      ? stderr
      : null;
  if (!out) return Promise.resolve("unknown");

  return new Promise<TerminalBackgroundMode>((resolve) => {
    let buffer = "";
    let resolved = false; // P8
    let timer: NodeJS.Timeout | undefined;

    // P9 / P10: remember state to restore after the probe.
    const hadRaw = stdin.isRaw === true;
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);
      // P9: restore the previous raw mode rather than blindly disabling it.
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(hadRaw);
      // P10: leave stdin's flow state as we found it for Ink to take over.
      if (wasPaused && typeof stdin.pause === "function") stdin.pause();
    };

    const finish = (mode: TerminalBackgroundMode): void => {
      if (resolved) return; // P8
      resolved = true;
      cleanup();
      resolve(mode);
    };

    const onData = (chunk: Buffer | string): void => {
      // P3: accumulate across chunks; never parse a single chunk in isolation.
      buffer += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      const match = OSC11_REPLY.exec(buffer); // P4
      if (!match) return;
      const payload = match[1];
      if (payload === undefined) return;
      const rgb = parseOscColor(payload);
      // P5: resolve as soon as a complete reply is parsed (no OSC 4 palette).
      if (!rgb) {
        finish("unknown"); // P11
        return;
      }
      finish(classifyByLuminance(rgb));
    };

    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.on("data", onData);
    if (typeof stdin.resume === "function") stdin.resume();

    out.write(OSC11_QUERY);

    timer = setTimeout(() => finish("unknown"), timeoutMs);
    // Do not keep the event loop alive solely for this probe.
    if (typeof timer.unref === "function") timer.unref();
  });
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse an OSC color payload into 0..255 channels. Handles the canonical
 * `rgb:RRRR/GGGG/BBBB` form with 1-4 hex digits per channel (P6) and the
 * `#rrggbb` / `#rgb` forms. Returns `null` on anything malformed (P11).
 */
function parseOscColor(payload: string): Rgb | null {
  if (payload.startsWith("rgb:")) {
    const parts = payload.slice(4).split("/");
    if (parts.length !== 3) return null;
    const [rh, gh, bh] = parts;
    if (rh === undefined || gh === undefined || bh === undefined) return null;
    const r = scaleHexChannel(rh);
    const g = scaleHexChannel(gh);
    const b = scaleHexChannel(bh);
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }
  if (payload.startsWith("#")) {
    return parseHashColor(payload.slice(1));
  }
  return null;
}

// P6: scale a variable-width hex component to 0..255 via its own max value.
function scaleHexChannel(hex: string): number | null {
  if (hex.length === 0 || hex.length > 4 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const value = parseInt(hex, 16);
  const max = 16 ** hex.length - 1;
  return Math.round((value / max) * 255);
}

function parseHashColor(hex: string): Rgb | null {
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  if (hex.length === 3) {
    const r = hex.slice(0, 1);
    const g = hex.slice(1, 2);
    const b = hex.slice(2, 3);
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  return null;
}

// P7: relative luminance on 0..255 channels, normalized once.
function classifyByLuminance(rgb: Rgb): TerminalBackgroundMode {
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

/**
 * Map a detected background mode to the startup theme. The single switch point
 * for the autodetect feature: `dark`/`unknown` -> atomic-retro, `light` ->
 * github-light.
 */
export function resolveStartupTheme(mode: TerminalBackgroundMode): TuiTheme {
  return mode === "light" ? THEMES["github-light"] : THEMES["atomic-retro"];
}
