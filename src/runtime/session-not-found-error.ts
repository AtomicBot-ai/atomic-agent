/**
 * Thrown by `previewPrompt` for an id the store does not hold. Matched by
 * name at the HTTP edge so the route module needs no value import of
 * the runtime.
 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}
