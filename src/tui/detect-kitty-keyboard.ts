import type { Writable } from "node:stream";

/**
 * Does this terminal speak the kitty keyboard protocol?
 *
 * It matters for exactly one reason: in the legacy encoding a terminal
 * sends the same byte (`\r`) for Enter and for Shift+Enter, so the
 * modifier is not observable and Shift+Enter cannot mean "newline". The
 * kitty protocol encodes it as `ESC [ 13 ; 2 u`, which Ink's parser
 * already turns into `key.return` + `key.shift`.
 *
 * The probe is the protocol's own query — `CSI ? u` — answered by
 * `CSI ? <flags> u`. Terminals that do not implement it answer nothing,
 * which is why this is a timeout rather than an error.
 *
 * Ink can auto-detect this itself (`kittyKeyboard: { mode: "auto" }`),
 * but its probe listener and the App's own reader both see the reply,
 * so the answer can be typed into the composer as `[?1u` before the
 * first render. Asking here — before `render`, on a stdin we hand back
 * exactly as we found it — keeps the reply out of the app entirely, and
 * gives the hint strip something to tell the truth with.
 *
 * The safety properties mirror `detectTerminalBackground`, deliberately:
 * never touch raw mode off a TTY, restore raw/flow state, resolve once,
 * and never keep the event loop alive for a probe.
 */
export interface DetectKittyKeyboardDeps {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Fallback timeout in ms before giving up. Default 150. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 150;

/** `CSI ? <flags> u` — the reply to the query below. */
const KITTY_REPLY = /\x1b\[\?(\d{1,4})u/;

/** `CSI ? u` — "which keyboard flags are set?". */
const KITTY_QUERY = "\x1b[?u";

export function detectKittyKeyboard(
  deps: DetectKittyKeyboardDeps = {},
): Promise<boolean> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!stdin.isTTY) return Promise.resolve(false);

  const out: NodeJS.WriteStream | null = stdout.isTTY
    ? stdout
    : stderr.isTTY
      ? stderr
      : null;
  if (!out) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let buffer = "";
    let resolved = false;
    let timer: NodeJS.Timeout | undefined;

    const hadRaw = stdin.isRaw === true;
    const wasPaused =
      typeof stdin.isPaused === "function" ? stdin.isPaused() : false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(hadRaw);
      if (wasPaused && typeof stdin.pause === "function") stdin.pause();
    };

    const finish = (supported: boolean): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(supported);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      if (KITTY_REPLY.test(buffer)) finish(true);
    };

    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.on("data", onData);
    if (typeof stdin.resume === "function") stdin.resume();

    (out as unknown as Writable).write(KITTY_QUERY);

    timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}
