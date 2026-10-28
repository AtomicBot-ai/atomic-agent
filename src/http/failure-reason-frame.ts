import { getConfig } from "../config/index.js";
import {
  LOCAL_ENGINE_DOWN_CODE,
  LOCAL_OUT_OF_MEMORY_CODE,
  classifyLocalServerError,
  isLocalEngineDown,
  isLocalOutOfMemory,
} from "../llm/reliability/index.js";

/** The machine-readable reason fields a turn's failure frame may carry. */
export interface FailureReasonFields {
  /**
   * `local_engine_down` (ATO-772); `local_server_not_found` (a 404/405 at
   * `localModels.url`, the address the Reconnect check probes),
   * `local_provider_not_found` (the same from another llama-server
   * address: no Reconnect), `local_context_exceeded` or
   * `local_request_invalid` (ATO-708, ATO-873, ATO-737);
   * `local_out_of_memory` (ATO-334: the managed model ran out of memory
   * and was not brought back). Hosts branch on
   * it instead of reading the words.
   */
  code?: string;
  /**
   * For the local-server codes: the plain sentence and what to do, with
   * no terminal commands in it, for a host that shows its own row. The
   * frame's `error` keeps the agent's raw words, which hosts already
   * match on (`llama-server returned http 404`, `answered 404`).
   */
  advice?: string;
}

/** `localModels.url` as the running agent uses it, or null when unreadable. */
export function currentLlamaUrl(): string | null {
  try {
    return getConfig().localModels.url;
  } catch {
    return null;
  }
}

/**
 * The reason fields for a failed frame. `ending` is the error that ended
 * the turn (the chain's last link: a dead managed engine is read there,
 * since that is the model a host would start, and it wins over any
 * local-server code); `shown` is the error the frame's message comes
 * from (the first link, when the chain fell over), so a local-server
 * code always matches the words beside it. `llamaUrl` is the address
 * the Reconnect check probes.
 */
export function failureReasonFields(
  shown: unknown,
  ending: unknown,
  llamaUrl: string | null,
): FailureReasonFields {
  if (isLocalEngineDown(ending)) return { code: LOCAL_ENGINE_DOWN_CODE };
  // ATO-334: a host can offer a smaller model or a restart with a smaller window.
  if (isLocalOutOfMemory(ending)) return { code: LOCAL_OUT_OF_MEMORY_CODE };
  const local = classifyLocalServerError(shown, { llamaUrl });
  if (local === null) return {};
  return { code: local.code, advice: `${local.message} ${local.advice}` };
}
