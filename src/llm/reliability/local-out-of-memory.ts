import { TransportError } from "./llm-failures.js";

/**
 * The machine-readable reason a turn ended because the managed local
 * model ran out of memory and was not (or could not be) brought back
 * with a smaller context window (ATO-334). Hosts branch on it: the
 * desktop can offer a smaller model, a terminal prints the sentence.
 */
export const LOCAL_OUT_OF_MEMORY_CODE = "local_out_of_memory";

/**
 * The managed local model ran out of memory, and the turn ends with a
 * sentence the person can act on instead of waiting out a server that
 * keeps its socket and fails every request.
 *
 * Still a `transport` failure, so every consumer that keys on the
 * category reads it as before. The server error that revealed it is kept
 * on `cause`. `status` is `null` on purpose: this error is a verdict, not
 * a server answer, and must never be read as one more 500 to recover.
 */
export class LocalOutOfMemoryError extends TransportError {
  readonly reasonCode = LOCAL_OUT_OF_MEMORY_CODE;

  constructor(
    message: string,
    /** The window the model ran out of memory with; `0` when unknown. */
    readonly contextWindow: number,
    /** The window a restart would use next; `null` when none is left to try. */
    readonly nextContextWindow: number | null,
    cause?: unknown,
  ) {
    super(message, null, "", cause === undefined ? undefined : { cause });
    this.name = "LocalOutOfMemoryError";
  }
}

export function isLocalOutOfMemory(err: unknown): err is LocalOutOfMemoryError {
  return err instanceof LocalOutOfMemoryError;
}
