import { isRequestSizeRejection, requestSizeRejectionNamesContext } from "../../llm/reliability/request-size-rejection.js";

/** Local HTTP 400s arrive wrapped in GrammarError; cloud ones in TransportError. */
export function contextCompactionRejection(error: unknown): unknown | null {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (isRequestSizeRejection(current) && requestSizeRejectionNamesContext(current)) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}
