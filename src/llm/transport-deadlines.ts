import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import { ENV_DEFAULTS } from "../config/config-schema.js";
import type { AtomicAgentConfig } from "../config/index.js";

/**
 * How far above the longest budget this process can express the
 * transport's own deadlines sit. A minute: enough that our timer always
 * wins the race, small enough that a request nobody is timing still
 * ends in the same order of magnitude it used to.
 */
export const TRANSPORT_DEADLINE_MARGIN_MS = 60_000;

/**
 * The fallback `OpenAiProvider` applies when a provider entry names no
 * `requestTimeoutMs`. Lives here so the ceiling that has to clear it
 * and the value itself cannot drift apart.
 */
export const OPENAI_DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Node's global `fetch` is undici, and undici enforces two deadlines of
 * its own *below* every `AbortSignal` this codebase arms:
 * `headersTimeout` (send to first response header) and `bodyTimeout`
 * (the gap between body chunks), **300 000 ms each by default**. No
 * call site ever installed a dispatcher, so those two were the real
 * ceiling on every request, and every budget above five minutes was
 * unreachable:
 *
 *   `localModels.firstTokenTimeoutMs`   30 min   never fired
 *   `localModels.streamTotalTimeoutMs`   6 h     never fired
 *   `SLOTS_UNREACHABLE_BUDGET_MS`       10 min   never fired
 *   the Fusion worker's queue budget    15 min   never fired
 *   `OpenAiHttpDeps.requestTimeoutMs`   10 min   cut to 5
 *
 * along with whatever an operator put in
 * `ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS`, however high.
 *
 * Measured against a socket that accepts the connection and answers
 * nothing, with a 30-minute signal attached: the request died at
 * 301 037 ms as `TypeError: fetch failed`, cause `HeadersTimeoutError
 * (UND_ERR_HEADERS_TIMEOUT)` — a bare message with no errno, which
 * `slotsPollFailure` and `readErrnoCode` both read, correctly, as
 * proving nothing. In the field that was two Fusion workers reporting
 * `error: fetch failed` with zero steps at 306 s each, against a
 * llama-server that was listening the whole time.
 *
 * **Why the global dispatcher rather than one per request.** Node's
 * built-in `fetch` validates a per-request `dispatcher` against its own
 * internal copy of undici and rejects one from this package outright
 * (`UND_ERR_INVALID_ARG`, measured at 9 ms). It does accept the same
 * object installed as the global default, which is what
 * `setGlobalDispatcher` does — so the choice is between one global
 * install and replacing `fetch` itself at every LLM call site. The
 * global costs less and leaves `globalThis.fetch` exactly as it was.
 *
 * It is a process-wide setting, which AGENTS.md's "no global
 * singletons" rule would normally refuse. It is one because undici's
 * defaults are one: this replaces a hidden global with a stated one,
 * installed by an explicit call from `createAgentRuntime` rather than
 * by an import side effect, and the numbers come from the config that
 * call already holds.
 *
 * **What it means for requests that are not to a model.** Raising the
 * ceiling raises it for every `fetch` in the process, so a request with
 * no clock of its own would now hang for this long instead of 300 s.
 * Every such call site is given an `AbortSignal` of its own in the same
 * change — the ones that had none were relying on undici's default by
 * accident, which is a bug at that call site either way.
 */
export function transportDeadlinesFor(config?: AtomicAgentConfig): {
  headersTimeout: number;
  bodyTimeout: number;
} {
  // No config yet: the process entry points install a floor off the
  // shipped defaults before anything reads a config file, because
  // `getConfig()` writes one on first use and an install path must not
  // create state before the command line has even been parsed. The
  // runtime widens it from the real config a moment later.
  const local = config?.localModels ?? {
    firstTokenTimeoutMs: ENV_DEFAULTS.FIRST_TOKEN_TIMEOUT_MS,
    requestTimeoutMs: ENV_DEFAULTS.REQUEST_TIMEOUT_MS,
  };
  // `llm` is optional on the resolved config (a bare install has no
  // provider list yet), and a provider that names no timeout of its own
  // gets the same default `OpenAiProvider` applies.
  const providerTimeouts = (config?.llm?.providers ?? []).map(
    (entry) => entry.requestTimeoutMs ?? OPENAI_DEFAULT_REQUEST_TIMEOUT_MS,
  );
  // Headers cover the whole wait before the first byte, which for a
  // local stream is queueing behind busy slots plus prompt evaluation.
  const headers = largest([
    local.firstTokenTimeoutMs,
    local.requestTimeoutMs,
    OPENAI_DEFAULT_REQUEST_TIMEOUT_MS,
    ...providerTimeouts,
  ]);
  // The body deadline is re-armed on every chunk, exactly like the
  // client's own `idle` budget — so it is that budget it has to clear,
  // not `streamTotalTimeoutMs`, which caps a whole reply rather than
  // any one gap in it.
  const body = largest([
    local.requestTimeoutMs,
    OPENAI_DEFAULT_REQUEST_TIMEOUT_MS,
    ...providerTimeouts,
  ]);
  return {
    headersTimeout: headers + TRANSPORT_DEADLINE_MARGIN_MS,
    bodyTimeout: body + TRANSPORT_DEADLINE_MARGIN_MS,
  };
}

/** What is installed now, so a second call can only ever widen it. */
let installed: { headersTimeout: number; bodyTimeout: number } | null = null;

/**
 * Install the deadlines for this process. Idempotent and monotone: a
 * later call with smaller numbers is ignored, so a second runtime built
 * in the same process (the HTTP test harness does this) cannot narrow
 * the ceiling under a turn that is already running on it.
 *
 * The three `localModels` budgets are read from the environment at load
 * time and have no user-config keys, and a provider's
 * `requestTimeoutMs` is hand-edited into the config file, so nothing a
 * running UI can do moves these numbers under us.
 */
export function installTransportDeadlines(config?: AtomicAgentConfig): {
  headersTimeout: number;
  bodyTimeout: number;
} {
  const wanted = transportDeadlinesFor(config);
  const next = {
    headersTimeout: Math.max(
      wanted.headersTimeout,
      installed?.headersTimeout ?? 0,
    ),
    bodyTimeout: Math.max(wanted.bodyTimeout, installed?.bodyTimeout ?? 0),
  };
  if (
    installed !== null &&
    next.headersTimeout === installed.headersTimeout &&
    next.bodyTimeout === installed.bodyTimeout
  ) {
    return installed;
  }
  setGlobalDispatcher(
    proxyConfigured(process.env)
      ? new EnvHttpProxyAgent(next)
      : new Agent(next),
  );
  installed = next;
  return installed;
}

/**
 * Does the environment ask for an HTTP proxy?
 *
 * Installing a plain `Agent` as the global dispatcher **replaces** the
 * proxy-aware one Node installs for `--use-env-proxy` / `NODE_USE_ENV_PROXY`,
 * so a host that can only reach the network through a proxy would lose
 * every request, and one that can reach it directly would route around
 * the sanctioned proxy. `EnvHttpProxyAgent` reads the same variables
 * Node does (`http_proxy`, `https_proxy`, `no_proxy`, either case), so
 * lifting the ceiling costs no proxy support either way.
 */
export function proxyConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.HTTP_PROXY ??
      env.http_proxy ??
      env.HTTPS_PROXY ??
      env.https_proxy ??
      env.NODE_USE_ENV_PROXY,
  );
}

/** Test seam: forget what this process installed. */
export function resetTransportDeadlines(): void {
  installed = null;
}

function largest(values: ReadonlyArray<number | undefined>): number {
  let best = 0;
  for (const value of values) {
    // A missing or unusable figure must not win, and must not drag the
    // ceiling back down to undici's default either.
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    if (value > best) best = value;
  }
  return best;
}
