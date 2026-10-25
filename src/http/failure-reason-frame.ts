import {
  LOCAL_ENGINE_DOWN_CODE,
  classifyLocalServerError,
  isLocalEngineDown,
} from "../llm/reliability/index.js";

/** The machine-readable reason fields a turn's failure frame may carry. */
export interface FailureReasonFields {
  /**
   * `local_engine_down` (ATO-772), `local_server_not_found`,
   * `local_context_exceeded` or `local_request_invalid` (ATO-708,
   * ATO-873, ATO-737). Hosts branch on it instead of reading the words.
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

/**
 * The reason fields for a failed turn. `ending` is the error that ended
 * the turn (the chain's last link: a dead managed engine is read there,
 * since that is the model a host would start); `shown` is the error the
 * frame's message comes from (the first link, when the chain fell over),
 * so a local-server code always matches the words beside it.
 */
export function failureReasonFields(shown: unknown, ending: unknown): FailureReasonFields {
  if (isLocalEngineDown(ending)) return { code: LOCAL_ENGINE_DOWN_CODE };
  const local = classifyLocalServerError(shown);
  if (local === null) return {};
  return { code: local.code, advice: `${local.message} ${local.advice}` };
}
