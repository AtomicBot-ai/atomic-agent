import { TransportError } from "./llm-failures.js";

/**
 * The machine-readable reason a turn ended because the Atomic Chat desktop
 * app, which serves the `atomic-chat` provider on 127.0.0.1:1337, refused
 * the connection past a short start grace (ATO-1278). Hosts branch on it.
 */
export const ATOMIC_CHAT_NOT_RUNNING_CODE = "atomic_chat_not_running";

/** The sentence every surface shows for it. */
export const ATOMIC_CHAT_NOT_RUNNING_MESSAGE = "Atomic Chat is not running. Open it and try again.";

/**
 * A refused connection (`ECONNREFUSED`) to the `atomic-chat` link, the
 * active text provider, that kept being refused through the start grace.
 * Nothing here starts that app: it is the operator's to open, so waiting
 * out the whole provider-wait budget only delays the message. Modelled on
 * `LocalEngineDownError`: still a `transport` failure, with the refusal
 * kept on `cause`.
 */
export class AtomicChatNotRunningError extends TransportError {
  readonly reasonCode = ATOMIC_CHAT_NOT_RUNNING_CODE;

  constructor(
    readonly providerId: string,
    cause?: unknown,
  ) {
    super(ATOMIC_CHAT_NOT_RUNNING_MESSAGE, null, "", cause === undefined ? undefined : { cause });
    this.name = "AtomicChatNotRunningError";
  }
}

export function isAtomicChatNotRunning(err: unknown): err is AtomicChatNotRunningError {
  return err instanceof AtomicChatNotRunningError;
}
