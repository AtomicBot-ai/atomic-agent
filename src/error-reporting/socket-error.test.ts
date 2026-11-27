import { describe, expect, it } from "vitest";

import {
  isLoopbackAddress,
  isLoopbackPeerGone,
  socketErrorTags,
} from "./socket-error.js";

/** undici's `SocketError` as `fetch` hands it over, wrapped in `TypeError`. */
function undiciSocketError(remoteAddress: string): Error {
  const inner = Object.assign(new Error("other side closed"), {
    name: "SocketError",
    code: "UND_ERR_SOCKET",
    socket: { remoteAddress, remotePort: 8080, localAddress: "127.0.0.1" },
  });
  return new TypeError("fetch failed", { cause: inner });
}

describe("isLoopbackPeerGone", () => {
  it("claims a socket to a local server closed under the request", () => {
    expect(isLoopbackPeerGone(undiciSocketError("127.0.0.1"))).toBe(true);
    expect(isLoopbackPeerGone(undiciSocketError("::1"))).toBe(true);
    expect(isLoopbackPeerGone(undiciSocketError("::ffff:127.0.0.1"))).toBe(
      true,
    );
  });

  it("claims a reset that names a loopback address", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      address: "127.0.0.1",
    });
    expect(isLoopbackPeerGone(err)).toBe(true);
  });

  it("does not claim a remote peer", () => {
    expect(isLoopbackPeerGone(undiciSocketError("203.0.113.7"))).toBe(false);
  });

  it("does not claim a reset whose peer it cannot prove", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(isLoopbackPeerGone(err)).toBe(false);
  });

  it("does not claim a refused connection to localhost", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
    });
    expect(isLoopbackPeerGone(err)).toBe(false);
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(isLoopbackPeerGone(err)).toBe(false);
  });
});

describe("socketErrorTags", () => {
  it("names the code and the peer class, never the address or port", () => {
    const tags = socketErrorTags(undiciSocketError("203.0.113.7"));
    expect(tags).toEqual({
      socket_error_code: "UND_ERR_SOCKET",
      socket_peer: "remote",
      undici_frame: "no",
    });
    expect(JSON.stringify(tags)).not.toContain("203.0.113.7");
    expect(JSON.stringify(tags)).not.toContain("8080");
  });

  it("flags an assertion raised inside undici's socket close handler", () => {
    const err = Object.assign(new Error("The expression evaluated to a falsy value"), {
      name: "AssertionError",
      code: "ERR_ASSERTION",
    });
    err.stack = [
      "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value",
      "    at Socket.onHttpSocketClose (/snapshot/cli.mjs:12:345)",
      "    at Socket.emit (node:events:519:28)",
    ].join("\n");
    expect(socketErrorTags(err)).toEqual({
      socket_error_code: "ERR_ASSERTION",
      socket_peer: "unknown",
      undici_frame: "yes",
    });
  });

  it("sends an unlisted code as other when undici raised it", () => {
    const err = Object.assign(new Error("x"), { code: "SOMETHING_NEW" });
    err.stack = "Error: x\n    at writeH1 (/snapshot/cli.mjs:1:2)";
    expect(socketErrorTags(err)?.socket_error_code).toBe("other");
  });

  it("leaves an error that is not a socket failure alone", () => {
    expect(socketErrorTags(new Error("boom"))).toBeUndefined();
    expect(socketErrorTags("ECONNRESET")).toBeUndefined();
  });
});

describe("isLoopbackAddress", () => {
  it("reads loopback forms and rejects the rest", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost"]) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
    for (const a of ["10.0.0.1", "192.168.1.2", "fe80::1", "127.0.0.999"]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });
});
