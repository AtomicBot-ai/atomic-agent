/**
 * Canonical error type thrown by every runtime-api service. Transport
 * adapters (sidecar router, HTTP handlers) map `code` onto their own
 * error envelope (`SidecarError.code` / OpenAI `error.type` + HTTP status)
 * so business logic never needs to know which transport invoked it.
 */
export type RuntimeApiErrorCode =
  | "not_found"
  | "subsystem_disabled"
  | "invalid_request"
  | "conflict"
  | "internal";

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    public readonly code: RuntimeApiErrorCode,
    /** Field name for validation errors, surfaced to the host UI. */
    public readonly field?: string,
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

/** Map a `RuntimeApiErrorCode` to the closest HTTP status code. */
export function runtimeApiErrorStatus(code: RuntimeApiErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "subsystem_disabled":
      return 404;
    case "invalid_request":
      return 400;
    case "conflict":
      return 409;
    case "internal":
      return 500;
  }
}
