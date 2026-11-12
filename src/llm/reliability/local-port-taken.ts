import { TransportError } from "./llm-failures.js";

/**
 * The machine-readable reason a turn on the managed local model ended
 * because something else answers on its port (ATO-1277). Hosts branch on
 * it the way they branch on `local_engine_down`.
 */
export const LOCAL_PORT_TAKEN_CODE = "local_port_taken";

/** What happened, one plain sentence. */
export const LOCAL_PORT_TAKEN_MESSAGE =
  "Another program is using the local model's port (for example Atomic Chat or a second copy of the engine).";

/** What to do, with no commands in it, so every surface can show it. */
export const LOCAL_PORT_TAKEN_ADVICE =
  "Close that program and start the model again, or set a different port in localModels.managed.port.";

/**
 * A 401 from the managed engine's address while the engine's own process
 * is certainly not there (no pid recorded, or a recorded pid that is
 * gone, and no start, load or install under way). Our engine is not
 * running, so the server that refused the key is someone else's: a
 * second Core, Atomic Chat's own Core, any program on that port. "The
 * local model server refused the agent's key" sent people to restart a
 * model that was not running.
 *
 * Read from our pid file only, never from the operating system's port
 * table: guessing a port's owner there is platform-fragile, and a wrong
 * guess would block a working engine.
 *
 * Still a `transport` failure with the 401 and the request URL, so every
 * consumer that keys on the category or the status reads it as before.
 * The refusal that revealed it is kept on `cause`.
 */
export class LocalPortTakenError extends TransportError {
  readonly reasonCode = LOCAL_PORT_TAKEN_CODE;

  constructor(
    readonly providerId: string,
    url: string,
    cause?: unknown,
  ) {
    super(
      `${LOCAL_PORT_TAKEN_MESSAGE} ${LOCAL_PORT_TAKEN_ADVICE}`,
      401,
      url,
      cause === undefined ? undefined : { cause },
    );
    this.name = "LocalPortTakenError";
  }
}

/** Depth cap on the `cause` walk; longer is a cycle. */
const MAX_CAUSE_DEPTH = 6;

/** The error itself or one of its causes is a {@link LocalPortTakenError}. */
export function findLocalPortTaken(err: unknown): LocalPortTakenError | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof LocalPortTakenError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
