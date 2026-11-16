/**
 * Typed errors for the MCP client. Centralised here so the manager,
 * adapter, and TUI consume the same shapes without re-deriving error
 * categories from string messages.
 */

/** Base class. Carries the offending server name. */
export class McpError extends Error {
  constructor(
    public readonly server: string,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** Connection-level failure (transport refused, handshake failed, etc.). */
export class McpConnectError extends McpError {
  constructor(server: string, message: string) {
    super(server, message);
    this.name = "McpConnectError";
  }
}

/** Plain message a server that wants a browser sign-in shows. */
export const MCP_SIGN_IN_REQUIRED_MESSAGE = "Sign in required";

/**
 * The remote server answered 401 and has no usable token: the person has
 * to sign in through the browser (`mcp-oauth-flow.ts`). The manager maps
 * it to the `needs_auth` state instead of `down`.
 */
export class McpAuthRequiredError extends McpConnectError {
  constructor(server: string, message: string = MCP_SIGN_IN_REQUIRED_MESSAGE) {
    super(server, message);
    this.name = "McpAuthRequiredError";
  }
}

/** Server explicitly refused a request (4xx-equivalent, `isError: true`). */
export class McpRequestError extends McpError {
  constructor(
    server: string,
    public readonly operation: string,
    message: string,
  ) {
    super(server, message);
    this.name = "McpRequestError";
  }
}

/** Operator-facing classification used by status badges and logs. */
export type McpFailureCategory =
  "config" | "connect" | "transport" | "protocol" | "tool" | "cancelled";

/**
 * Strip noisy `Error: ` prefixes, trim, and clip long error messages
 * to a fixed length. Used everywhere a user-facing surface (status
 * badge, TUI label, structured log) shows an error.
 */
export function scrubErrorMessage(err: unknown, maxLength = 200): string {
  if (err === null || err === undefined) return "(no error)";
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw.replace(/^Error:\s*/i, "").trim();
  return stripped.length > maxLength
    ? `${stripped.slice(0, maxLength - 1)}…`
    : stripped;
}
