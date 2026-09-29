// Must run before anything issues a request. undici — the implementation
// behind Node's global `fetch` — applies its own `headersTimeout` and
// `bodyTimeout` of 300_000 ms beneath every deadline this process sets, and
// those are the deadlines an operator can configure:
// `localModels.firstTokenTimeoutMs` (30 min by default), `requestTimeoutMs`,
// the stream budgets, a Fusion worker's own budget. All of them are
// AbortSignal timers one layer above undici, so undici wins first and the
// failure arrives as a bare `TypeError: fetch failed` — no errno, no provider
// message, nothing generated. A prompt evaluation longer than five minutes is
// ordinary on a loaded machine, and a whole fan-out of local workers can come
// back with zero steps because of it.
//
// `headersTimeout` goes to 0: waiting for the first byte is queueing behind
// busy slots plus prompt evaluation, which the local client already bounds
// with `firstTokenTimeoutMs`.
//
// `bodyTimeout` stays finite. It is undici's inactivity timer, and for a cloud
// SSE stream it is the only idle bound there is — the request deadline in
// `openai-http.ts` is cleared once the headers resolve. 45 minutes sits above
// every budget the config can set while still catching a stream that dies
// silently, instead of letting it run to the task ceiling.
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * How long a request may wait for the first byte (0 = no limit here; the
 * caller's own signal decides) and how long it may then sit idle.
 */
export const LLM_DISPATCHER_OPTIONS = {
  headersTimeout: 0,
  bodyTimeout: 45 * 60 * 1_000,
  connectTimeout: 30_000,
} as const;

/**
 * Does the environment ask for an HTTP proxy?
 *
 * A plain `Agent` as the global dispatcher silently drops Node's env-proxy
 * support, so a host that can only reach the network through a proxy would
 * lose every request — and one that can would route around the sanctioned
 * proxy. `EnvHttpProxyAgent` reads the same variables Node does.
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

setGlobalDispatcher(
  proxyConfigured(process.env)
    ? new EnvHttpProxyAgent({ ...LLM_DISPATCHER_OPTIONS })
    : new Agent({ ...LLM_DISPATCHER_OPTIONS }),
);
