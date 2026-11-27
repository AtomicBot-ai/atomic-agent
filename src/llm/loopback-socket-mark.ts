import { isIP } from "node:net";

import { buildConnector } from "undici";

/**
 * ATO-2767: prove, where the socket is opened, that its peer is this
 * machine.
 *
 * A socket reset under a read (`Error("read ECONNRESET")`, `syscall:
 * "read"`) carries no address: Node builds it from the errno alone. So
 * the error that reaches the process-global handler cannot say, by
 * itself, that the far end was a local model server restarting, and
 * `serve` took the fatal path for it. Every socket the agent's HTTP pool
 * opens goes through this connector; one whose remote address is
 * loopback gets a first `error` listener that marks the error object
 * before anyone else sees it. The same object is what undici rejects
 * with, rethrows, or what goes uncaught, so the mark travels with it.
 *
 * The mark is a registry symbol, not an import: `src/error-reporting`
 * takes nothing from the LLM layer, and reads it by the same
 * `Symbol.for` key (`socket-error.ts`).
 */
export const LOOPBACK_PEER_MARK = Symbol.for("atomic-agent.loopbackPeer");

/** The connector's options and callback, as undici types them. */
type ConnectOptions = buildConnector.BuildOptions;
type Connector = buildConnector.connector;

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopbackIp(address: string | undefined): boolean {
  if (typeof address !== "string" || isIP(address) === 0) return false;
  const host = address.toLowerCase().replace(/^::ffff:/, "");
  return host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Mark `err` as having come from a socket whose peer is loopback. */
export function markLoopbackError(err: unknown): void {
  if (typeof err !== "object" || err === null) return;
  try {
    Object.defineProperty(err, LOOPBACK_PEER_MARK, { value: true, enumerable: false });
  } catch {
    // A frozen error cannot carry the mark; it then reads as unknown, as before.
  }
}

/** The part of a socket the mark needs. */
export interface MarkableSocket {
  readonly remoteAddress?: string | undefined;
  prependListener(event: "error", listener: (err: Error) => void): unknown;
}

/** Give a connected socket to this machine the marking listener. */
export function markLoopbackSocket(socket: MarkableSocket): boolean {
  if (!isLoopbackIp(socket.remoteAddress)) return false;
  socket.prependListener("error", markLoopbackError);
  return true;
}

/**
 * undici's own connector (same defaults the Agent would build), with
 * each connected loopback socket marked. `base` is a test seam.
 */
export function loopbackMarkingConnector(
  options: ConnectOptions = {},
  base: Connector = buildConnector(options),
): Connector {
  return (opts, callback) =>
    base(opts, (err, socket) => {
      if (err === null && socket) markLoopbackSocket(socket);
      // undici types the callback as a two-branch union.
      (callback as (e: Error | null, s: unknown) => void)(err, socket);
    });
}

/** Agent options with the marking connector added. */
export function withLoopbackMark<T extends object>(options: T): T & { connect: Connector } {
  return { ...options, connect: loopbackMarkingConnector() };
}

