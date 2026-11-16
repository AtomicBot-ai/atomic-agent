/**
 * MCP browser sign-in (agent route `POST /api/mcp/servers/{name}/auth/start`).
 * The agent answers with the authorization server's sign-in page; the window
 * opens it in the person's own browser. This is the one check before
 * `shell.openExternal`: only a plain https page, never a `file:`, custom
 * scheme or a URL carrying a user name or password.
 */
export function isSafeSignInUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return url.hostname.length > 0;
}

/** Sign-in states the agent reports (`McpOAuthSignInState` in src/mcp/mcp-oauth-flow.ts). */
export type McpAuthState = "signed_out" | "pending" | "signed_in";
