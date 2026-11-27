import { isLoopbackPeerGone } from "./socket-error.js";

/**
 * What a process does with an *uncaught* exception that is a socket to
 * this machine reset or closed under a request (ATO-2767): a local
 * llama-server restarting, or killed under a stream (ATO-1735).
 *
 * - `exit` (the default): the usual fatal path, report and exit 1. Right
 *   for a CLI command, which ends anyway.
 * - `survive`: one line to stderr and carry on, unreported. `serve` is
 *   the desktop app's agent; exiting there drops every session the
 *   window has open because a model server it does not own restarted.
 *
 * Continuing is safe for this one shape. It reaches the global handler
 * as a destroyed socket's `error` event that had no listener left: the
 * request that used the socket already failed through its own path (the
 * fetch rejected, the turn reported a transport error and can be
 * retried), so no state is half-written by it. The non-fatal
 * `unhandledRejection` filter in `captureError` already treats the same
 * error as noise, and Node HTTP servers keep serving after one client
 * socket errors. Only a peer *proven* loopback from the error itself
 * counts (see `isLoopbackPeerGone`); a remote or unknown peer still
 * takes the fatal path.
 */
export type LoopbackResetPolicy = "exit" | "survive";

/** The one line `survive` writes; plain words, no address or port. */
export const LOOPBACK_RESET_NOTE =
  "[atomic-agent] a local connection was reset; continuing\n";

/**
 * True when `err` is a proven loopback reset and the policy is
 * `survive`: the caller then returns without capture or exit. Writes the
 * note to stderr, which may already be muted or closed.
 */
export function survivesLoopbackReset(
  err: unknown,
  policy: LoopbackResetPolicy,
): boolean {
  if (policy !== "survive" || !isLoopbackPeerGone(err)) return false;
  try {
    process.stderr.write(LOOPBACK_RESET_NOTE);
  } catch {
    // stderr is gone: the note has nowhere to go, the process still lives.
  }
  return true;
}
