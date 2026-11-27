/**
 * Socket failures that reach the process-global handlers (ATO-1735).
 *
 * Two jobs, both read on this machine:
 *
 *  - {@link isLoopbackPeerGone}: the far end of a socket to *this
 *    machine* went away mid-request (a local model server restarting,
 *    a llama-server killed under a stream). Nothing in the agent broke,
 *    so a process-global report of it is noise.
 *  - {@link socketErrorTags}: for every other global socket failure,
 *    three bounded words that say what it was, since the stack of a
 *    bundled build does not.
 *
 * The peer is only ever *proven* from the error itself: undici's
 * `SocketError` carries `socket.remoteAddress`, and a Node connect error
 * carries `address`. A raw `ECONNRESET` from a socket read or write
 * carries neither; it is proven only when the agent's own HTTP pool
 * marked it on a socket it opened to a loopback address (ATO-2767).
 * Without the mark it stays `unknown` and is still reported. The
 * address is classified here and never leaves the machine; nor does a
 * port.
 */

/** Codes that mean "the peer closed or reset the connection". */
const PEER_GONE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  // undici's "other side closed" / "closed": the server hung up.
  "UND_ERR_SOCKET",
]);

/** The only words `socket_error_code` may carry; anything else is `other`. */
const SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PEER_GONE_CODES,
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "UND_ERR_INFO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_ASSERTION",
]);

/** Depth cap on the `cause` walk: a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** How many stack lines of each link count as "the top frames". */
const TOP_FRAMES = 8;

/**
 * undici's HTTP/1 socket handlers. The shipped build is one bundled
 * file, so a frame's filename does not say undici; with `keepNames` its
 * function name still does.
 */
const UNDICI_FUNCTION_RE =
  /\bat (?:\S+\.)?(?:onHttpSocket(?:Close|Error|End|Readable)|writeH1|resumeH1|onParserTimeout)\b/;

export type SocketPeer = "loopback" | "remote" | "unknown";

/**
 * True when `err` (or its `cause` chain) is the peer of a socket to a
 * loopback address closing or resetting it. A peer that cannot be
 * proven loopback is not claimed.
 */
export function isLoopbackPeerGone(err: unknown): boolean {
  const links = causeChain(err);
  const gone = links.some((link) => {
    const code = (link as { code?: unknown }).code;
    return typeof code === "string" && PEER_GONE_CODES.has(code);
  });
  return gone && socketPeer(links) === "loopback";
}

/**
 * `socket_error_code`, `socket_peer` and `undici_frame` for a global
 * failure that is a socket error or was raised inside undici; `undefined`
 * for anything else.
 */
export function socketErrorTags(
  err: unknown,
): Record<string, string> | undefined {
  const links = causeChain(err);
  const code = firstSocketCode(links);
  const undiciFrame = links.some(hasUndiciFrame);
  if (code === undefined && !undiciFrame) return undefined;
  return {
    socket_error_code: code ?? "other",
    socket_peer: socketPeer(links),
    undici_frame: undiciFrame ? "yes" : "no",
  };
}

function causeChain(err: unknown): object[] {
  const links: object[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if (links.includes(current)) break;
    links.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return links;
}

function firstSocketCode(links: readonly object[]): string | undefined {
  for (const link of links) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && SOCKET_ERROR_CODES.has(code)) return code;
  }
  return undefined;
}

/**
 * ATO-2767: the mark the agent's HTTP pool puts on an error from a socket
 * it connected to a loopback address (`src/llm/loopback-socket-mark.ts`).
 * Read by its registry key, so this module imports nothing from the LLM
 * layer. It is the only proof a raw read reset can carry.
 */
const LOOPBACK_PEER_MARK = Symbol.for("atomic-agent.loopbackPeer");

function hasLoopbackMark(link: object): boolean {
  return (link as Record<symbol, unknown>)[LOOPBACK_PEER_MARK] === true;
}

function socketPeer(links: readonly object[]): SocketPeer {
  if (links.some(hasLoopbackMark)) return "loopback";
  for (const link of links) {
    const address = peerAddress(link);
    if (address !== undefined) {
      return isLoopbackAddress(address) ? "loopback" : "remote";
    }
  }
  return "unknown";
}

/** `address` of a Node net error, or undici's `socket.remoteAddress`. */
function peerAddress(link: object): string | undefined {
  const address = (link as { address?: unknown }).address;
  if (typeof address === "string" && address.length > 0) return address;
  const socket = (link as { socket?: unknown }).socket;
  if (typeof socket === "object" && socket !== null) {
    const remote = (socket as { remoteAddress?: unknown }).remoteAddress;
    if (typeof remote === "string" && remote.length > 0) return remote;
  }
  return undefined;
}

export function isLoopbackAddress(address: string): boolean {
  const host = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
  if (host === "::1" || host === "localhost") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

function hasUndiciFrame(link: object): boolean {
  const stack = (link as { stack?: unknown }).stack;
  if (typeof stack !== "string") return false;
  const frames = stack
    .split("\n")
    .filter((line) => /^\s*at /.test(line))
    .slice(0, TOP_FRAMES);
  return frames.some(
    (line) => /undici/i.test(line) || UNDICI_FUNCTION_RE.test(line),
  );
}
