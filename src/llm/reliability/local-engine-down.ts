import { TransportError } from "./llm-failures.js";

/**
 * The machine-readable reason a turn ended because the managed local model
 * process is certainly not running (ATO-772). Hosts branch on it: the
 * desktop shows a "Start model" button, a terminal prints the start command.
 */
export const LOCAL_ENGINE_DOWN_CODE = "local_engine_down";

/** The sentence every surface shows for it (ATO-771, option A). */
export const LOCAL_ENGINE_DOWN_MESSAGE = "The local model isn't running.";

/** What a terminal adds under it: the command that starts the model. */
export const LOCAL_ENGINE_START_HINT = "Start it with: atomic-agent models start";

/**
 * A refused connection to the managed local link, with the model process
 * known to be gone (a pid recorded and dead, or none recorded) and no
 * engine operation under way. Waiting would not bring it back: nothing
 * restarts a stopped model on its own, so the turn ends at once instead
 * of parking for the whole provider-wait budget.
 *
 * Still a `transport` failure, so every existing consumer that keys on the
 * category reads it as before. The connection error that revealed it is
 * kept on `cause`.
 */
export class LocalEngineDownError extends TransportError {
  readonly reasonCode = LOCAL_ENGINE_DOWN_CODE;

  constructor(
    readonly providerId: string,
    cause?: unknown,
  ) {
    super(LOCAL_ENGINE_DOWN_MESSAGE, null, "", cause === undefined ? undefined : { cause });
    this.name = "LocalEngineDownError";
  }
}

export function isLocalEngineDown(err: unknown): err is LocalEngineDownError {
  return err instanceof LocalEngineDownError;
}
