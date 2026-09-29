import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LLM_DISPATCHER_OPTIONS, proxyConfigured } from "./fetch-dispatcher-bootstrap.js";

/** A socket that accepts the connection and never answers. */
async function silentServer(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((socket) => {
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return { port: address.port, close: () => server.close() };
}

describe("LLM fetch dispatcher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the first-byte wait unbounded and the idle wait finite", () => {
    // 0 = the caller's own signal decides. `firstTokenTimeoutMs` bounds the
    // local wait; undici must not cut in under it at 300 s.
    expect(LLM_DISPATCHER_OPTIONS.headersTimeout).toBe(0);
    // Finite on purpose: for a cloud SSE stream this is the only idle bound,
    // and it has to sit above every budget the config can set.
    expect(LLM_DISPATCHER_OPTIONS.bodyTimeout).toBe(2_700_000);
    expect(LLM_DISPATCHER_OPTIONS.connectTimeout).toBe(30_000);
  });

  it("reads the same proxy variables Node does", () => {
    expect(proxyConfigured({})).toBe(false);
    expect(proxyConfigured({ HTTP_PROXY: "http://proxy:3128" })).toBe(true);
    expect(proxyConfigured({ https_proxy: "http://proxy:3128" })).toBe(true);
    expect(proxyConfigured({ NODE_USE_ENV_PROXY: "1" })).toBe(true);
  });

  it("installs a proxy-aware dispatcher when the environment asks for one", async () => {
    const built: string[] = [];
    vi.resetModules();
    vi.doMock("undici", () => ({
      Agent: class {
        constructor() {
          built.push("Agent");
        }
      },
      EnvHttpProxyAgent: class {
        constructor() {
          built.push("EnvHttpProxyAgent");
        }
      },
      setGlobalDispatcher: () => {},
    }));
    vi.stubEnv("HTTP_PROXY", "http://proxy.invalid:3128");
    await import("./fetch-dispatcher-bootstrap.js");
    expect(built).toEqual(["EnvHttpProxyAgent"]);
    vi.doUnmock("undici");
  });

  it("installs a plain agent when no proxy is configured", async () => {
    const built: string[] = [];
    vi.resetModules();
    vi.doMock("undici", () => ({
      Agent: class {
        constructor() {
          built.push("Agent");
        }
      },
      EnvHttpProxyAgent: class {
        constructor() {
          built.push("EnvHttpProxyAgent");
        }
      },
      setGlobalDispatcher: () => {},
    }));
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NODE_USE_ENV_PROXY"]) {
      vi.stubEnv(key, "");
    }
    await import("./fetch-dispatcher-bootstrap.js");
    expect(built).toEqual(["Agent"]);
    vi.doUnmock("undici");
  });

  it("global fetch really obeys the installed dispatcher", async () => {
    // The contract this fix rests on is undocumented: undici hands its global
    // dispatcher to Node's built-in fetch through a versioned symbol
    // (`undici.globalDispatcher.N`). A bump on either side would restore the
    // 300 s ceiling with every mock-based test still green, so this asserts
    // the real wiring with a short timeout instead of a long one.
    const server = await silentServer();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ headersTimeout: 700, bodyTimeout: 700 }));
    const started = Date.now();
    try {
      await fetch(`http://127.0.0.1:${server.port}/`);
      expect.unreachable("the silent server should never answer");
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      expect(cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      setGlobalDispatcher(previous);
      server.close();
    }
  });

  it("is imported before the rest of each entry point", () => {
    // Position is the whole point: a request issued during another module's
    // import would go out on the default dispatcher.
    const entries = ["./index.ts", "../sidecar/main.ts"];
    for (const entry of entries) {
      const source = readFileSync(fileURLToPath(new URL(entry, import.meta.url)), "utf8");
      const imports = source.split("\n").filter((line) => line.startsWith("import "));
      const bootstrap = imports.findIndex((line) => line.includes("fetch-dispatcher-bootstrap.js"));
      expect(bootstrap, `${entry} must import the dispatcher bootstrap`).toBeGreaterThanOrEqual(0);
      expect(bootstrap, `${entry} must import it before other modules`).toBeLessThanOrEqual(1);
    }
  });
});
