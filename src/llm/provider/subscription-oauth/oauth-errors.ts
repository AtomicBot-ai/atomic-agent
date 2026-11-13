/**
 * Error types for the OAuth primitives. Messages and fields carry only
 * codes, HTTP statuses and OAuth error identifiers: never tokens, codes,
 * verifiers, URLs with query strings or server-provided descriptions.
 */

export type OAuthFlowErrorCode =
  | "callback_port_unavailable"
  | "state_mismatch"
  | "duplicate_callback"
  | "callback_timeout"
  | "missing_code"
  | "authorization_denied"
  | "cancelled"
  | "network_error"
  | "token_request_failed"
  | "invalid_token_response"
  | "device_code_expired";

export interface OAuthFlowErrorDetails {
  status?: number;
  oauthError?: string;
}

export class OAuthFlowError extends Error {
  readonly code: OAuthFlowErrorCode;
  readonly status: number | undefined;
  readonly oauthError: string | undefined;

  constructor(code: OAuthFlowErrorCode, details: OAuthFlowErrorDetails = {}) {
    const parts = [`OAuth flow failed: ${code}`];
    if (details.status !== undefined) parts.push(`status ${details.status}`);
    if (details.oauthError !== undefined) parts.push(details.oauthError);
    super(parts.join(" / "));
    this.name = "OAuthFlowError";
    this.code = code;
    this.status = details.status;
    this.oauthError = details.oauthError;
  }
}

export type SignInRequiredReason =
  | "no_tokens"
  | "no_refresh_token"
  | "refresh_refused";

/** The stored session cannot be renewed; the user has to sign in again. */
export class SignInRequiredError extends Error {
  readonly reason: SignInRequiredReason;

  constructor(reason: SignInRequiredReason) {
    super(`Subscription session expired, sign in again (${reason})`);
    this.name = "SignInRequiredError";
    this.reason = reason;
  }
}

const SAFE_OAUTH_ERROR = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * OAuth `error` values are short registered identifiers. Anything else is
 * replaced so a hostile or buggy server cannot smuggle data into logs.
 */
export function sanitizeOAuthError(value: unknown): string {
  return typeof value === "string" && SAFE_OAUTH_ERROR.test(value)
    ? value
    : "unknown";
}
