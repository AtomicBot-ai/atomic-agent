import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { isLoopbackPeerGone } from "../error-reporting/socket-error.js";
import {
  LOOPBACK_PEER_MARK,
  isLoopbackIp,
  loopbackMarkingConnector,
  markLoopbackSocket,
} from "./loopback-socket-mark.js";

// ATO-2767: a read reset carries no address, so the peer is proven where
// the socket is opened. These drive a REAL reset socket, the shape Node
// emits ("read ECONNRESET", syscall "read", no `address`).

let server: Server | null = null;

afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A server on 127.0.0.1 that resets each connection once it gets a byte. */
async function resettingServer(): Promise<number> {
  server = createServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", () => sock.resetAndDestroy());
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** Connect through the marking connector, send a byte, answer the error the reset raises. */
function resetThroughConnector(port: number): Promise<NodeJS.ErrnoException> {
  const connect = loopbackMarkingConnector();
  return new Promise((resolve, reject) => {
    connect(
      { hostname: "127.0.0.1", host: `127.0.0.1:${port}`, protocol: "http:", port: String(port) },
      (err, socket) => {
        if (err !== null || !socket) {
          reject(err ?? new Error("no socket"));
          return;
        }
        (socket as Socket).on("error", (e) => resolve(e as NodeJS.ErrnoException));
        socket.write("x");
      },
    );
  });
}

describe("loopback socket mark (ATO-2767)", () => {
  it("a real read reset from a local server is proven loopback", async () => {
    const err = await resetThroughConnector(await resettingServer());
    expect(err.code).toBe("ECONNRESET");
    // The shape that made serve exit: nothing in it names the peer.
    expect((err as { address?: unknown }).address).toBeUndefined();
    expect((err as unknown as Record<symbol, unknown>)[LOOPBACK_PEER_MARK]).toBe(true);
    expect(isLoopbackPeerGone(err)).toBe(true);
  });

  it("the same error without the mark stays unproven", () => {
    const raw = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      errno: -54,
      syscall: "read",
    });
    expect(isLoopbackPeerGone(raw)).toBe(false);
  });

  it("marks only sockets whose remote address is loopback", () => {
    const listeners: string[] = [];
    const socket = (remoteAddress: string | undefined) => ({
      remoteAddress,
      prependListener: (event: "error") => {
        listeners.push(event);
      },
    });
    expect(markLoopbackSocket(socket("127.0.0.1"))).toBe(true);
    expect(markLoopbackSocket(socket("::1"))).toBe(true);
    expect(markLoopbackSocket(socket("::ffff:127.0.0.1"))).toBe(true);
    expect(markLoopbackSocket(socket("203.0.113.7"))).toBe(false);
    expect(markLoopbackSocket(socket(undefined))).toBe(false);
    expect(listeners).toEqual(["error", "error", "error"]);
  });

  it("reads loopback from an IP only, never a name", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("127.10.0.3")).toBe(true);
    expect(isLoopbackIp("localhost")).toBe(false);
    expect(isLoopbackIp("10.0.0.1")).toBe(false);
  });
});
