import { getConfig } from "../../config/index.js";
import {
  McpAddServerError,
  parseAddServerJson,
  persistMcpServer,
} from "../../config/mcp-server-commands.js";
import { findMonidServer, monidAddServerJson } from "../../integrations/index.js";
import type { McpOAuthStartResult } from "../../mcp/mcp-oauth-flow.js";
import { createMcpOAuthStore } from "../../mcp/mcp-oauth-store.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { openUrlInBrowser, type OpenUrlResult } from "../open-url.js";

/**
 * The Monid half of the hub orchestrator (ATO-1630). "Sign in with
 * Monid" is two steps the MCP tab already owns: add the catalog card's
 * server when it is not configured yet, then run the browser sign-in
 * every remote MCP server has. Nothing here is a second copy of either.
 */
export interface MonidHubDeps {
  /**
   * Start a browser sign-in for one MCP server. `McpOrchestrator.startSignIn`
   * in the app, so the MCP tab and this row share one sign-in in flight.
   */
  startSignIn?: (name: string) => Promise<McpOAuthStartResult>;
  /**
   * Forget one MCP server's saved sign-in and reconnect it.
   * `McpOrchestrator.forgetSignIn` in the app, the same as `/mcp signout`.
   */
  signOut?: (name: string) => Promise<void>;
  /** Test seam; the default opens the system browser. */
  openUrl?: (url: string) => Promise<OpenUrlResult>;
}

type MonidRuntime = Pick<AgentRuntime, "mcpManager" | "refreshMcp">;

/**
 * Name of the Monid server, adding the catalog card's one first when no
 * server points at Monid yet. Pressing sign in again, or after the card
 * was used, finds the existing server and adds nothing.
 */
export async function ensureMonidServer(
  runtime: MonidRuntime,
): Promise<{ name: string; added: boolean }> {
  const existing = findMonidServer(getConfig().mcp?.servers);
  if (existing) return { name: existing.name, added: false };
  let server: McpServerConfig;
  try {
    // The same text the catalog card puts in the add box.
    server = parseAddServerJson(monidAddServerJson());
    persistMcpServer(server);
  } catch (err) {
    const why = err instanceof McpAddServerError || err instanceof Error ? err.message : String(err);
    throw new Error(`Could not add the Monid server: ${why}`);
  }
  try {
    // It has no sign-in yet, so it comes up as "needs sign-in"; the
    // sign-in below reconnects it once the browser comes back.
    await runtime.mcpManager.addServerLive(server);
    await runtime.refreshMcp?.();
  } catch {
    // The server is in config.json; the sign-in reconnect retries the mount.
  }
  return { name: server.name, added: true };
}

/** Run the row's sign-in and say what happened, in one line. */
export async function runMonidSignIn(
  runtime: MonidRuntime,
  deps: MonidHubDeps,
): Promise<string> {
  if (!deps.startSignIn) {
    throw new Error("Browser sign-in is not available here. Use /mcp auth monid instead.");
  }
  const { name, added } = await ensureMonidServer(runtime);
  const result = await deps.startSignIn(name);
  const prefix = added ? "Monid server added. " : "";
  if (result.state === "signed_in") return `${prefix}Signed in to Monid`;
  const opened = await (deps.openUrl ?? openUrlInBrowser)(result.authUrl);
  if (!opened.ok) {
    return `${prefix}Open this link to sign in to Monid: ${result.authUrl}`;
  }
  return `${prefix}Your browser opened to sign in to Monid. Press r here once it says you are signed in.`;
}

/** The row's Disconnect: forget the saved sign-in; the server entry stays. */
export async function runMonidDisconnect(deps: MonidHubDeps): Promise<string> {
  if (!deps.signOut) {
    throw new Error("Signing out is not available here. Use /mcp signout monid instead.");
  }
  const server = findMonidServer(getConfig().mcp?.servers);
  if (!server) return "Monid is not connected";
  await deps.signOut(server.name);
  return "Disconnected from Monid. Its tools stop until you sign in again (press s).";
}

/**
 * Configured remote MCP servers with a saved browser sign-in, read from
 * the same token store the sign-in writes. Never throws: an unreadable
 * record reads as "not signed in".
 */
export function readMcpSignedIn(
  stateDir: string,
  servers: readonly McpServerConfig[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!servers || servers.length === 0) return out;
  const store = createMcpOAuthStore(stateDir);
  for (const s of servers) {
    if (s.transport.kind === "stdio") continue;
    try {
      if (store.hasTokens(s.name, s.transport.url)) out.add(s.name);
    } catch {
      // A name the store refuses cannot have a sign-in.
    }
  }
  return out;
}
