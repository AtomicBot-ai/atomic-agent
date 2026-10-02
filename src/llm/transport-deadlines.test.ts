import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

import type { AtomicAgentConfig } from "../config/index.js";
import {
  installTransportDeadlines,
  proxyConfigured,
  resetTransportDeadlines,
  transportDeadlinesFor,
  OPENAI_DEFAULT_REQUEST_TIMEOUT_MS,
  TRANSPORT_DEADLINE_MARGIN_MS,
} from "./transport-deadlines.js";

/** undici's default for both deadlines, and the ceiling this lifts. */
const UNDICI_DEFAULT_MS = 300_000;

function configWith(
  local: Partial<AtomicAgentConfig["localModels"]>,
  providers: Array<{ requestTimeoutMs?: number }> = [],
): AtomicAgentConfig {
  return {
    localModels: {
      firstTokenTimeoutMs: 30 * 60_000,
      requestTimeoutMs: 300_000,
      streamTotalTimeoutMs: 6 * 60 * 60_000,
      ...local,
    },
    llm: { providers },
  } as unknown as AtomicAgentConfig;
}

describe("transportDeadlinesFor", () => {
  it("clears undici's default on the shipped budgets", () => {
    const { headersTimeout, bodyTimeout } = transportDeadlinesFor(
      configWith({}),
    );
    expect(headersTimeout).toBe(30 * 60_000 + TRANSPORT_DEADLINE_MARGIN_MS);
    // The body deadline is re-armed per chunk, so it answers to the idle
    // budget — but never below what a cloud provider may legitimately
    // take before its first chunk either.
    expect(bodyTimeout).toBe(
      OPENAI_DEFAULT_REQUEST_TIMEOUT_MS + TRANSPORT_DEADLINE_MARGIN_MS,
    );
    expect(headersTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
    expect(bodyTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
  });

  it("follows an operator who raised the local budgets", () => {
    // `ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS=1800000` was set in the
    // field and did nothing, because undici's 300 s sat under it.
    const { headersTimeout, bodyTimeout } = transportDeadlinesFor(
      configWith({ firstTokenTimeoutMs: 3 * 60 * 60_000, requestTimeoutMs: 1_800_000 }),
    );
    expect(headersTimeout).toBe(3 * 60 * 60_000 + TRANSPORT_DEADLINE_MARGIN_MS);
    expect(bodyTimeout).toBe(1_800_000 + TRANSPORT_DEADLINE_MARGIN_MS);
  });

  it("covers a provider that asked for longer than any local budget", () => {
    const { headersTimeout, bodyTimeout } = transportDeadlinesFor(
      configWith({}, [{ requestTimeoutMs: 4 * 60 * 60_000 }, {}]),
    );
    expect(headersTimeout).toBe(4 * 60 * 60_000 + TRANSPORT_DEADLINE_MARGIN_MS);
    expect(bodyTimeout).toBe(4 * 60 * 60_000 + TRANSPORT_DEADLINE_MARGIN_MS);
  });

  it("is never dragged back down by a budget it cannot use", () => {
    // A hand-written config, a `NaN` from a bad env var, a provider
    // entry with a zero — none of them may restore the 300 s ceiling.
    const { headersTimeout, bodyTimeout } = transportDeadlinesFor(
      configWith(
        {
          firstTokenTimeoutMs: Number.NaN,
          requestTimeoutMs: undefined as unknown as number,
        },
        [{ requestTimeoutMs: 0 }, { requestTimeoutMs: -1 }],
      ),
    );
    expect(headersTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
    expect(bodyTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
  });
});

describe("transportDeadlinesFor with no config", () => {
  it("still clears undici's default, off the shipped defaults", () => {
    // The floor the process entry points install before any config file
    // exists: `getConfig()` writes one on first use, and an install path
    // or `--help` must not create state to raise a network timeout.
    const { headersTimeout, bodyTimeout } = transportDeadlinesFor();
    expect(headersTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
    expect(bodyTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
    // And the real config widens it, never narrows it.
    const raised = transportDeadlinesFor(
      configWith({ firstTokenTimeoutMs: 3 * 60 * 60_000 }),
    );
    expect(raised.headersTimeout).toBeGreaterThan(headersTimeout);
  });
});

describe("proxyConfigured", () => {
  // A plain `Agent` as the global dispatcher replaces the proxy-aware
  // one Node installs for `--use-env-proxy`, so a host that can only
  // reach the network through a proxy would lose every request. Every
  // spelling Node reads has to count.
  it.each([
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NODE_USE_ENV_PROXY",
  ])("reads %s", (key) => {
    expect(proxyConfigured({ [key]: "http://proxy.invalid:3128" })).toBe(true);
  });

  it("is false when nothing asks for one", () => {
    expect(proxyConfigured({})).toBe(false);
    expect(proxyConfigured({ NO_PROXY: "*" })).toBe(false);
  });
});

describe("installTransportDeadlines", () => {
  const original = getGlobalDispatcher();

  afterEach(() => {
    delete process.env.HTTP_PROXY;
    setGlobalDispatcher(original);
    resetTransportDeadlines();
  });

  it("keeps proxy support when the environment asks for one", () => {
    process.env.HTTP_PROXY = "http://proxy.invalid:3128";
    installTransportDeadlines();
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("uses a plain pool when nothing asks for a proxy", () => {
    installTransportDeadlines();
    const dispatcher = getGlobalDispatcher();
    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("only ever widens what this process already installed", () => {
    // The HTTP test harness builds a second runtime in one process; a
    // narrower config must not cut the ceiling under a turn already
    // running on the wider one.
    const wide = installTransportDeadlines(
      configWith({ firstTokenTimeoutMs: 3 * 60 * 60_000 }),
    );
    const afterNarrow = installTransportDeadlines(
      configWith({ firstTokenTimeoutMs: 60_000 }),
    );
    expect(afterNarrow).toEqual(wide);
  });
});

describe("the transport ceiling on a server that answers nothing", () => {
  const original = getGlobalDispatcher();

  afterEach(() => {
    setGlobalDispatcher(original);
    resetTransportDeadlines();
  });

  /**
   * A socket that accepts the connection and then answers nothing —
   * the shape a llama-server takes when its HTTP loop has wedged: the
   * process is listening, the port is open, no byte ever comes back.
   */
  async function silentServer(): Promise<{ url: string; close: () => void }> {
    const server = net.createServer(() => {
      // Hold the connection open and write nothing.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}/completion`,
      close: () => server.close(),
    };
  }

  async function failureOf(
    url: string,
    signalMs: number,
  ): Promise<{ name: string; causeCode: string | undefined }> {
    try {
      await fetch(url, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(signalMs),
      });
      throw new Error("expected the request to fail");
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      return { name: (err as Error).name, causeCode: cause?.code };
    }
  }

  it("kills the request under the caller's own clock when the transport's is shorter", async () => {
    // The bug. 200 ms stands in for the 300 000 ms undici applies out of
    // the box — the number is the only difference, and sitting through
    // the real one would cost five minutes of CI per run. What matters
    // is the shape: a bare `TypeError: fetch failed` whose only detail
    // is a cause code, naming no budget and no remedy, while the
    // caller's own 30-second signal never gets a say. In the field that
    // was two Fusion workers at 306 s with zero steps.
    const server = await silentServer();
    try {
      setGlobalDispatcher(new Agent({ headersTimeout: 200, bodyTimeout: 200 }));
      const failure = await failureOf(server.url, 30_000);
      expect(failure.name).toBe("TypeError");
      expect(failure.causeCode).toBe("UND_ERR_HEADERS_TIMEOUT");
    } finally {
      server.close();
    }
  });

  it("leaves the caller's clock in charge once the deadlines are installed", async () => {
    // The fix. Same silent server, same request — the transport's
    // deadline now sits above every budget this process can express, so
    // the abort carries the caller's own kind and a caller with a real
    // budget (a 30-minute first-token wait) gets to use it.
    const server = await silentServer();
    try {
      // Start from the losing position of the test above, so the
      // install is the only thing that can change the outcome: without
      // it this request dies on the transport's 200 ms with
      // `UND_ERR_HEADERS_TIMEOUT`, exactly as it did on undici's 300 s.
      setGlobalDispatcher(new Agent({ headersTimeout: 200, bodyTimeout: 200 }));
      installTransportDeadlines(configWith({}));
      // Comfortably past when a 200 ms transport deadline actually
      // fires: undici's timer wheel is coarse, so that one lands around
      // a second, and a signal any tighter would win on granularity
      // rather than on the install.
      const failure = await failureOf(server.url, 3_000);
      expect(failure.name).toBe("TimeoutError");
      expect(failure.causeCode).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
