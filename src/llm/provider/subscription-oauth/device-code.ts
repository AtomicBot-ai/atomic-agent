import {
  OAuthFlowError,
  sanitizeOAuthError,
} from "./oauth-errors.js";
import type { Clock, FetchLike, OAuthTokens, Sleep } from "./oauth-types.js";
import { abortableSleep } from "./sleep.js";
import { isRecord, postForm, requestToken } from "./token-request.js";

/** RFC 8628 device authorization grant. Endpoints and ids are injected. */
export interface DeviceCodeOptions {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  extraParams?: Record<string, string>;
  fetch: FetchLike;
  signal?: AbortSignal;
  now?: Clock;
  sleep?: Sleep;
}

export interface DeviceAuthorization {
  /** Opaque; sent only to the token endpoint, never shown or logged. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 section 3.2 default and section 3.5 slow_down increment. */
const DEFAULT_INTERVAL_MS = 5_000;
const SLOW_DOWN_STEP_MS = 5_000;

export async function requestDeviceAuthorization(
  options: DeviceCodeOptions,
): Promise<DeviceAuthorization> {
  const now = options.now ?? Date.now;
  const params: Record<string, string> = {
    ...options.extraParams,
    client_id: options.clientId,
  };
  if (options.scope !== undefined) params.scope = options.scope;
  const { status, ok, body } = await postForm(
    options.fetch,
    options.deviceAuthorizationUrl,
    params,
    options.signal,
  );
  if (!ok) {
    throw new OAuthFlowError("token_request_failed", {
      status,
      oauthError: sanitizeOAuthError(isRecord(body) ? body.error : undefined),
    });
  }
  if (
    !isRecord(body) ||
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw new OAuthFlowError("invalid_token_response", { status });
  }
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  const authorization: DeviceAuthorization = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : DEFAULT_INTERVAL_MS,
  };
  if (typeof body.verification_uri_complete === "string") {
    authorization.verificationUriComplete = body.verification_uri_complete;
  }
  return authorization;
}

/**
 * Polls the token endpoint until the user approves, honoring `interval`,
 * `slow_down`, expiry and cancellation through `options.signal`.
 */
export async function pollDeviceToken(
  options: DeviceCodeOptions,
  authorization: DeviceAuthorization,
): Promise<OAuthTokens> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  let intervalMs = authorization.intervalMs;

  for (;;) {
    if (options.signal?.aborted) throw new OAuthFlowError("cancelled");
    if (now() + intervalMs > authorization.expiresAt) {
      throw new OAuthFlowError("device_code_expired");
    }
    await sleep(intervalMs, options.signal);
    const result = await requestToken({
      fetch: options.fetch,
      url: options.tokenUrl,
      now,
      ...(options.signal ? { signal: options.signal } : {}),
      params: {
        ...options.extraParams,
        grant_type: DEVICE_GRANT,
        device_code: authorization.deviceCode,
        client_id: options.clientId,
      },
    });
    if (result.kind === "tokens") return result.tokens;
    switch (result.oauthError) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      case "expired_token":
        throw new OAuthFlowError("device_code_expired");
      case "access_denied":
        throw new OAuthFlowError("authorization_denied", { oauthError: "access_denied" });
      default:
        throw new OAuthFlowError("token_request_failed", {
          status: result.status,
          oauthError: result.oauthError,
        });
    }
  }
}
