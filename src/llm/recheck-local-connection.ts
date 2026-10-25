import {
  describeLlamaHealthFailure,
  looksLikeAtomicChatUrl,
  looksLikeOllamaUrl,
} from "./describe-llama-health-failure.js";
import { llamaDefaultPortNote, llamaLegacyPortNote } from "./llama-default-port-note.js";
import { checkLlamaServer, type HealthCheckOptions, type HealthResult } from "./llama-server-health.js";
import { isLocalProviderUrl } from "./provider/presets/is-local-provider-url.js";

/**
 * What the Reconnect check found at the llama.cpp address (ATO-873):
 *
 *  - `ok`: a llama.cpp server answers `/health` there. That does not
 *    prove its chat route has a model; the message says so.
 *  - `loading`: a llama.cpp server is there, still loading its model.
 *  - `ollama` / `atomic_chat` / `openai_compat`: an OpenAI-compatible
 *    server answers there, which the llama.cpp route cannot drive; it
 *    belongs under the cloud providers.
 *  - `key_rejected`: a llama.cpp server that refuses the agent's key.
 *  - `not_model_server`: something answered, but not a model server.
 *  - `unreachable`: nothing answered at all.
 */
export type LocalConnectionVerdict =
  | "ok"
  | "loading"
  | "ollama"
  | "atomic_chat"
  | "openai_compat"
  | "key_rejected"
  | "not_model_server"
  | "unreachable";

export interface LocalConnectionCheck {
  /** The address that was checked. */
  readonly url: string;
  readonly verdict: LocalConnectionVerdict;
  /** True only for `ok`: a llama.cpp server answers (not a promise the chat route works). */
  readonly ok: boolean;
  /** The verdict in one or two plain sentences. */
  readonly message: string;
  /**
   * Where a current llama-server listens, for a loopback address on one
   * of llama.cpp's default ports that is not a working llama-server: on
   * 8080 something else answered (or nothing did), and the server is
   * most likely on 9931. The check never rewrites the address. Null
   * otherwise.
   */
  readonly portHint: string | null;
}

export interface RecheckLocalConnectionOptions {
  /** The llama.cpp address to check (`localModels.url` for the caller's own route). */
  readonly url: string;
  /** The agent's own engine ports, for the key-refused wording. */
  readonly managedPorts?: readonly number[];
  /** Per-request budget; one attempt, no retry ladder. */
  readonly timeoutMs?: number;
  /** Test seam; `checkLlamaServer` by default. */
  readonly check?: (options: HealthCheckOptions) => Promise<HealthResult>;
}

/** Long enough for a dead host on Windows, short enough to feel like a button. */
const RECHECK_TIMEOUT_MS = 5_000;

/**
 * Check the llama.cpp address again, the same way saving it does
 * (`checkLlamaServer` with `verifyAuth`, then `describeLlamaHealthFailure`
 * for the words), and say what is there. Behind the desktop's Reconnect
 * button and `atomic-agent models check` (ATO-873, variant B). Reads and
 * writes no config.
 */
export async function recheckLocalConnection(
  options: RecheckLocalConnectionOptions,
): Promise<LocalConnectionCheck> {
  const { url } = options;
  const check = options.check ?? checkLlamaServer;
  const health = await check({
    url,
    retries: 0,
    backoffMs: 0,
    timeoutMs: options.timeoutMs ?? RECHECK_TIMEOUT_MS,
    verifyAuth: true,
  });
  const verdict = verdictOf(health, url);
  return {
    url,
    verdict,
    ok: verdict === "ok",
    message: messageOf(verdict, health, url, options),
    portHint: portHintOf(verdict, url),
  };
}

function messageOf(
  verdict: LocalConnectionVerdict,
  health: HealthResult,
  url: string,
  options: RecheckLocalConnectionOptions,
): string {
  switch (verdict) {
    case "ok":
      // `/health` passing does not prove the chat route serves a model:
      // say what was checked, and what a second 404 would mean.
      return (
        `${url} answers as a llama.cpp server. Send the message again; ` +
        `if it fails with 404 again, no model is loaded behind its chat route.`
      );
    case "not_model_server":
      return `${url} answers${health.status === null ? "" : ` (http ${health.status})`}, but it isn't a model server.`;
    case "unreachable":
      return `Nothing answers at ${url}. Start the model server, or check the address.`;
    default:
      // The save-time words: Ollama / Atomic Chat / OpenAI-compatible
      // steer to the cloud providers, loading says wait, a refused key
      // names where the key lives.
      return describeLlamaHealthFailure(health, url, options.managedPorts ?? []);
  }
}

function portHintOf(verdict: LocalConnectionVerdict, url: string): string | null {
  if (verdict === "not_model_server") return llamaLegacyPortNote(url);
  // Nothing answered on a default port: the server is most likely on the
  // other one, in either direction.
  if (verdict === "unreachable") return llamaDefaultPortNote(url);
  return null;
}

function verdictOf(health: HealthResult, url: string): LocalConnectionVerdict {
  switch (health.kind) {
    case "llama-server":
      return health.reachable ? "ok" : "not_model_server";
    case "llama-loading":
      return "loading";
    case "llama-auth":
      return "key_rejected";
    case "openai-compat":
      if (looksLikeOllamaUrl(url)) return "ollama";
      if (looksLikeAtomicChatUrl(url) && isLocalProviderUrl(url)) return "atomic_chat";
      return "openai_compat";
    default:
      return health.status === null ? "unreachable" : "not_model_server";
  }
}
