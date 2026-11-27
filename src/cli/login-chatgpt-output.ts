import {
  ChatgptNoAccountError,
  OAuthFlowError,
  type ChatgptDeviceCode,
  type OAuthTokens,
} from "../llm/provider/subscription-oauth/index.js";

/**
 * ATO-2510: what `atag login chatgpt` prints, as sentences for a person or,
 * with `--json`, one JSON object per line for a program (the desktop app).
 * The desktop used to read the English sentences to learn whether the
 * sign-in worked and which provider entry it used; with `--json` it reads
 * the `type` of each line instead, so rewording a sentence breaks nothing.
 *
 * Line shapes (same `type` key as `atag run --json`):
 *  - `authorization_url` {url, opened}: the browser sign-in link.
 *  - `device_code` {verificationUrl, userCode, expiresInMinutes}: `--device`.
 *  - `signed_in` {providerId, providerAdded, model, modelSource, plan}.
 *  - `notice` {message}: a sentence that is not an event (store warning,
 *    which provider is active now).
 *  - `error` {reason, code?, message}: reason is timeout, no_account,
 *    cancelled or failed; code is the OAuth flow code or "usage".
 * No line ever carries a token or the server's own text.
 */

export type LoginFailureReason = "timeout" | "no_account" | "cancelled" | "failed";

export type LoginEvent =
  | { type: "authorization_url"; url: string; opened: boolean }
  | { type: "device_code"; verificationUrl: string; userCode: string; expiresInMinutes: number }
  | {
      type: "signed_in";
      providerId: string;
      providerAdded: boolean;
      model: string;
      modelSource: "backend" | "fallback";
      plan: string | null;
    }
  | { type: "notice"; message: string }
  | { type: "error"; reason: LoginFailureReason; code?: string; message: string };

/** The device code lives this long (OpenAI's device flow, as `codex login --device-auth`). */
const DEVICE_CODE_MINUTES = 15;

/** One sentence per failure, never the server's own text or a token. */
export function describeLoginFailure(err: unknown): string {
  if (err instanceof ChatgptNoAccountError) return err.message;
  if (err instanceof OAuthFlowError) {
    switch (err.code) {
      case "cancelled":
        return "Sign-in cancelled.";
      case "callback_timeout":
        return "Sign-in timed out: the browser never came back. Try again, or use --device.";
      case "callback_port_unavailable":
        return "Ports 1455 and 1457 are both in use (another sign-in still open?). Close it and try again, or use --device.";
      case "device_code_expired":
        return "The code expired before it was entered. Run the command again for a new one.";
      case "state_mismatch":
        return "Sign-in refused: the browser answer did not belong to this attempt.";
      case "authorization_denied":
        return "Sign-in was not approved in the browser.";
      case "network_error":
        return "Cannot reach auth.openai.com. Check the connection and try again.";
      default:
        if (err.oauthError === "device_login_not_enabled") {
          return "Device sign-in is not enabled for this account. Use the browser sign-in instead.";
        }
        return `Sign-in failed (${err.code}${err.status ? `, ${err.status}` : ""}).`;
    }
  }
  return "Sign-in failed.";
}

/** The machine-readable reason the desktop wizard shows its own text for. */
export function loginFailureReason(err: unknown): LoginFailureReason {
  if (err instanceof ChatgptNoAccountError) return "no_account";
  if (err instanceof OAuthFlowError) {
    if (err.code === "cancelled") return "cancelled";
    if (err.code === "callback_timeout" || err.code === "device_code_expired") return "timeout";
  }
  return "failed";
}

export function expiryLine(tokens: OAuthTokens): string {
  if (tokens.expiresAt === undefined) return "";
  return ` Access token valid until ${new Date(tokens.expiresAt).toISOString()} (renewed automatically).`;
}

export interface SignedInInfo {
  providerId: string;
  providerAdded: boolean;
  model: string;
  modelSource: "backend" | "fallback";
  plan: string | null;
}

export interface LoginOutput {
  readonly json: boolean;
  /** The one-line header before the sign-in starts. */
  start(): void;
  authorizationUrl(url: string, opened: boolean): void;
  deviceCode(code: ChatgptDeviceCode): void;
  signedIn(info: SignedInInfo, tokens: OAuthTokens): void;
  /** A plain sentence (store warning, activation): a `notice` line in JSON. */
  notice(text: string): void;
  failure(err: unknown): void;
  usageError(message: string, help: string): void;
}

export function createLoginOutput(json: boolean, write: (text: string) => void): LoginOutput {
  const emit = (event: LoginEvent): void => write(`${JSON.stringify(event)}\n`);
  if (json) {
    return {
      json,
      start: () => {},
      authorizationUrl: (url, opened) => emit({ type: "authorization_url", url, opened }),
      deviceCode: (code) =>
        emit({
          type: "device_code",
          verificationUrl: code.verificationUrl,
          userCode: code.userCode,
          expiresInMinutes: DEVICE_CODE_MINUTES,
        }),
      signedIn: (info) => emit({ type: "signed_in", ...info }),
      notice: (text) => {
        const message = text.trim();
        if (message) emit({ type: "notice", message });
      },
      failure: (err) => {
        const code = err instanceof OAuthFlowError ? err.code : undefined;
        emit({ type: "error", reason: loginFailureReason(err), ...(code ? { code } : {}), message: describeLoginFailure(err) });
      },
      usageError: (message) => emit({ type: "error", reason: "failed", code: "usage", message }),
    };
  }
  return {
    json,
    start: () => write("ChatGPT sign-in (experimental; the Codex CLI provider stays the recommended way).\n"),
    authorizationUrl: (url, opened) =>
      write(
        opened
          ? "Opened the sign-in page in your browser. Waiting... (Ctrl+C to cancel)\n"
          : `Open this link in a browser on this computer to sign in:\n\n${url}\n\nWaiting... (Ctrl+C to cancel; on another machine use --device)\n`,
      ),
    deviceCode: (code) =>
      write(
        [
          "",
          `1. Open ${code.verificationUrl} on any device and sign in.`,
          `2. Enter this code (expires in ${DEVICE_CODE_MINUTES} minutes): ${code.userCode}`,
          "",
          "Only continue if you started this sign-in. If someone else gave you this code, stop.",
          "Waiting for approval... (Ctrl+C to cancel)",
          "",
        ].join("\n"),
      ),
    signedIn: (info, tokens) =>
      write(
        `Signed in${info.plan ? ` (ChatGPT ${info.plan})` : ""}.${expiryLine(tokens)}\n` +
          (info.providerAdded
            ? `Added provider "${info.providerId}" (ChatGPT subscription, experimental), model ${info.model} (${info.modelSource === "backend" ? "Codex's current default" : "Codex's default; the live list could not be read"}).\n`
            : `Provider "${info.providerId}" now uses this sign-in.\n`),
      ),
    notice: (text) => write(text.endsWith("\n") ? text : `${text}\n`),
    failure: (err) => write(`${describeLoginFailure(err)}\n`),
    usageError: (message, help) => write(`${message}\n\n${help}\n`),
  };
}
