/**
 * OAuth client provider for remote MCP servers ("sign in through the
 * browser"), backed by `mcp-oauth-store.ts`.
 *
 * Only a type is taken from `@modelcontextprotocol/sdk` here; every SDK
 * call (`auth()`, transports) stays in `mcp-client.ts`.
 *
 * Two modes:
 *   - `connect`: attached to every remote transport the manager opens.
 *     It hands out saved tokens and saves refreshed ones. When the
 *     server asks for a sign-in it records nothing about the attempt
 *     (no verifier, no URL) so a reconnect can never clobber a sign-in
 *     the person is completing in the browser; the connect then fails
 *     with `UnauthorizedError` and the server shows "Sign in required".
 *   - `signin`: used by the sign-in flow (`mcp-oauth-flow.ts`). It
 *     generates the CSRF `state`, keeps the PKCE verifier and records the
 *     authorization URL instead of opening a browser: the agent can run
 *     headless or on another machine, so the URL goes back to whichever
 *     UI asked (desktop, TUI) and that UI opens it.
 */

import { randomBytes } from "node:crypto";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import type { McpOAuthStore } from "./mcp-oauth-store.js";
import type { McpTransport } from "./mcp-types.js";

type ClientMetadata = OAuthClientProvider["clientMetadata"];
type ClientInformation = NonNullable<
  Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>
>;
type Tokens = NonNullable<Awaited<ReturnType<OAuthClientProvider["tokens"]>>>;

/** Name the agent registers itself under with an authorization server. */
export const MCP_OAUTH_CLIENT_NAME = "Atomic Agent";
/** Loopback host of the redirect. RFC 8252 prefers the IP over "localhost". */
export const MCP_OAUTH_CALLBACK_HOST = "127.0.0.1";
/** Path the loopback listener answers on. */
export const MCP_OAUTH_CALLBACK_PATH = "/callback";
/**
 * Fixed default port, so the redirect URI registered once stays valid
 * across restarts. When it is busy the flow tries the next few ports
 * and then any free one; a different port means a different redirect
 * URI, so the client is registered again for it (see `clientInformation`).
 */
export const MCP_OAUTH_DEFAULT_PORT = 47613;

export function mcpOAuthRedirectUri(port: number): string {
  return `http://${MCP_OAUTH_CALLBACK_HOST}:${port}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** Redirect URI the default port gives. */
export const MCP_OAUTH_DEFAULT_REDIRECT_URI = mcpOAuthRedirectUri(MCP_OAUTH_DEFAULT_PORT);

/**
 * Header names that already carry a credential. A server configured with
 * one of these signs in with that key, not through the browser, and gets
 * no OAuth provider: its requests stay exactly as they were.
 */
const CREDENTIAL_HEADER_RE =
  /^(authorization|proxy-authorization)$|api[-_]?key|token|secret|password/i;

export function hasStaticCredentialHeader(
  headers: Record<string, string> | undefined,
): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => CREDENTIAL_HEADER_RE.test(name));
}

/**
 * True when browser sign-in applies to this transport: remote (Streamable
 * HTTP or SSE) and no credential in the configured headers. stdio servers
 * never use it.
 */
export function usesMcpOAuth(transport: McpTransport): boolean {
  if (transport.kind === "stdio") return false;
  return !hasStaticCredentialHeader(transport.headers);
}

export type McpOAuthProviderMode = "connect" | "signin";

export interface McpOAuthProviderOptions {
  store: McpOAuthStore;
  server: string;
  url: string;
  mode: McpOAuthProviderMode;
  /**
   * Redirect URI for this provider. `signin` passes the one its listener
   * is bound to; `connect` defaults to the one the saved client was
   * registered with, or the default.
   */
  redirectUri?: string;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly store: McpOAuthStore;
  private readonly server: string;
  private readonly url: string;
  readonly mode: McpOAuthProviderMode;
  private readonly redirectUri: string;
  private lastState: string | null = null;
  private lastAuthUrl: string | null = null;
  private authRequested = false;

  constructor(options: McpOAuthProviderOptions) {
    this.store = options.store;
    this.server = options.server;
    this.url = options.url;
    this.mode = options.mode;
    this.redirectUri =
      options.redirectUri ??
      this.store.load(this.server, this.url).redirectUri ??
      MCP_OAUTH_DEFAULT_REDIRECT_URI;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): ClientMetadata {
    return {
      client_name: MCP_OAUTH_CLIENT_NAME,
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } as ClientMetadata;
  }

  /** Fresh CSRF value per authorization request; checked on the callback. */
  state(): string {
    const value = randomBytes(24).toString("base64url");
    if (this.mode === "signin") this.lastState = value;
    return value;
  }

  clientInformation(): ClientInformation | undefined {
    const rec = this.store.load(this.server, this.url);
    if (!rec.clientInformation) return undefined;
    // A client registered for another redirect URI cannot finish a sign-in
    // on this one; returning nothing makes the SDK register again.
    if (this.mode === "signin" && rec.redirectUri !== this.redirectUri) {
      return undefined;
    }
    return rec.clientInformation as unknown as ClientInformation;
  }

  saveClientInformation(info: ClientInformation): void {
    this.store.update(this.server, this.url, {
      clientInformation: info as unknown as Record<string, unknown>,
      redirectUri: this.redirectUri,
    });
  }

  tokens(): Tokens | undefined {
    const tokens = this.store.load(this.server, this.url).tokens;
    if (typeof tokens?.access_token !== "string") return undefined;
    return tokens as unknown as Tokens;
  }

  saveTokens(tokens: Tokens): void {
    this.store.update(this.server, this.url, {
      tokens: tokens as unknown as Record<string, unknown>,
      tokensSavedAt: Date.now(),
      codeVerifier: undefined,
      pendingAuthUrl: undefined,
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Never opens a browser: the URL goes back to the UI that asked.
    this.authRequested = true;
    if (this.mode !== "signin") return;
    this.lastAuthUrl = authorizationUrl.toString();
    this.store.update(this.server, this.url, { pendingAuthUrl: this.lastAuthUrl });
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.mode !== "signin") return;
    this.store.update(this.server, this.url, { codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.store.load(this.server, this.url).codeVerifier;
    if (!verifier) throw new Error("No sign-in is in progress for this server.");
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    switch (scope) {
      case "all":
        this.store.clear(this.server);
        return;
      case "client":
        this.store.update(this.server, this.url, {
          clientInformation: undefined,
          redirectUri: undefined,
        });
        return;
      case "tokens":
        this.store.update(this.server, this.url, { tokens: undefined, tokensSavedAt: undefined });
        return;
      case "verifier":
        this.store.update(this.server, this.url, { codeVerifier: undefined });
        return;
      default:
        return;
    }
  }

  /** The authorization request the last `auth()` run produced (signin mode). */
  pendingAuthorization(): { authUrl: string; state: string } | null {
    if (!this.lastAuthUrl || !this.lastState) return null;
    return { authUrl: this.lastAuthUrl, state: this.lastState };
  }

  /** True once the server asked for a sign-in during this provider's life. */
  get signInRequested(): boolean {
    return this.authRequested;
  }
}
