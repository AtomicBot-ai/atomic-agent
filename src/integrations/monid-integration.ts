/**
 * Monid as an Integrations-hub tenant (ATO-1630).
 *
 * Monid's MCP server takes a browser sign-in only (an API key in the
 * headers is refused), so this row has no key field. Its one verb,
 * "sign in with Monid", runs the browser sign-in remote MCP servers
 * already have (`src/mcp/mcp-oauth-flow.ts`, ATO-1613) and, when no
 * Monid server is configured yet, first adds the one the MCP catalog
 * card adds (`src/mcp/mcp-catalog-data.ts`, id `monid`).
 *
 * The catalog card stays. Both entry points end on the same server:
 * the hub adds exactly the card's config (`buildMcpCatalogJson`), and
 * `findMonidServer` treats a server named `monid` or one already
 * pointing at Monid's URL as "the" Monid server, so pressing sign in
 * again, or after the card was used, never adds a second one.
 *
 * Everything here is pure: the status reads the loaded config and the
 * sign-in set the orchestrator collects from the MCP OAuth token store.
 */

import { buildMcpCatalogJson, findMcpCatalogEntry } from "../mcp/mcp-catalog.js";
import type { McpCatalogEntry } from "../mcp/mcp-catalog.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";

export const MONID_INTEGRATION_ID = "monid";
/** The MCP catalog card this row shares its server with. */
export const MONID_CATALOG_ID = "monid";
export const MONID_SIGNIN_ACTION = "signin";
/** Forget the saved sign-in, like Composio's "d clears" on its key. */
export const MONID_DISCONNECT_ACTION = "disconnect";

/** The catalog card. Throws if the catalog lost it: the row would have nothing to add. */
export function monidCatalogEntry(): McpCatalogEntry {
  const entry = findMcpCatalogEntry(MONID_CATALOG_ID);
  if (!entry) throw new Error("the MCP catalog has no Monid entry");
  return entry;
}

/** Monid's MCP server URL, as the catalog card has it. */
export function monidServerUrl(): string {
  const url = monidCatalogEntry().server.url;
  if (typeof url !== "string") throw new Error("the Monid catalog entry has no URL");
  return url;
}

/**
 * The config text the row adds: byte-for-byte what the catalog card
 * produces, so both entry points write the same server.
 */
export function monidAddServerJson(): string {
  return buildMcpCatalogJson(monidCatalogEntry());
}

/** Host and path, lower-cased host, no trailing slash: enough to say "same server". */
function sameServerUrl(a: string, b: string): boolean {
  const norm = (raw: string): string | null => {
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

export interface MonidServerRef {
  name: string;
  /** Remote URL, or `null` for a server of that name that is not remote. */
  url: string | null;
}

/**
 * The configured server the Monid row drives, or `undefined` when none
 * is. A server already pointing at Monid's URL wins (whatever it was
 * named); otherwise one named `monid`, since a second `monid` could
 * not be added anyway.
 */
export function findMonidServer(
  servers: readonly unknown[] | undefined,
): MonidServerRef | undefined {
  if (!Array.isArray(servers)) return undefined;
  const target = monidServerUrl();
  let byName: MonidServerRef | undefined;
  for (const raw of servers) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as { name?: unknown; transport?: { kind?: unknown; url?: unknown } };
    if (typeof s.name !== "string") continue;
    const url =
      s.transport && s.transport.kind !== "stdio" && typeof s.transport.url === "string"
        ? s.transport.url
        : null;
    if (url !== null && sameServerUrl(url, target)) return { name: s.name, url };
    if (s.name === MONID_CATALOG_ID && byName === undefined) byName = { name: s.name, url };
  }
  return byName;
}

function configuredServers(ctx: IntegrationStatusContext): readonly unknown[] | undefined {
  const servers = (ctx.config?.mcp as { servers?: unknown } | undefined)?.servers;
  return Array.isArray(servers) ? (servers as unknown[]) : undefined;
}

/**
 * Row status, from the configured server, its live state and whether
 * the token store holds a sign-in for it:
 *
 * - no server, or no saved sign-in: not connected
 * - saved sign-in and the server answers: signed in
 * - saved sign-in but the server asks for a sign-in again: sign-in expired
 */
/** True when a Monid server is configured and the token store holds a sign-in for it. */
export function monidHasSignIn(ctx: IntegrationStatusContext): boolean {
  const server = findMonidServer(configuredServers(ctx));
  return !!server && (ctx.mcpSignedIn?.has(server.name) ?? false);
}

export function monidStatus(ctx: IntegrationStatusContext): IntegrationStatus {
  const server = findMonidServer(configuredServers(ctx));
  if (!server) {
    return { level: "not_configured", detail: "not signed in — press s to sign in with Monid" };
  }
  const state = ctx.mcpServerStates?.get(server.name);
  const signedIn = ctx.mcpSignedIn?.has(server.name) ?? false;
  if (state === "disabled") {
    return { level: "configured", detail: "turned off in the MCP tab" };
  }
  if (state === "needs_auth") {
    return signedIn
      ? { level: "error", detail: "sign-in expired — press s to sign in again" }
      : { level: "not_configured", detail: "not signed in — press s to sign in with Monid" };
  }
  if (!signedIn) {
    return { level: "not_configured", detail: "not signed in — press s to sign in with Monid" };
  }
  if (state === "up") return { level: "connected", detail: "signed in" };
  if (state === "down") {
    return { level: "error", detail: "signed in, but the connection failed — see the MCP tab" };
  }
  // A saved sign-in and no live signal yet (still connecting).
  return { level: "configured", detail: "signed in" };
}

export const monidIntegration: IntegrationDescriptor = {
  id: MONID_INTEGRATION_ID,
  label: "Monid",
  summary: "Pay-as-you-go data and automation tools for your agent, with your Monid account",
  docsUrl: "https://monid.ai",
  appliesLive: true,
  setupSteps: [
    "Press s to sign in with Monid. Your browser opens on Monid's sign-in page.",
    "Sign in there. When the page says you are signed in, come back here.",
    "Monid's tools load on their own. No API key is needed.",
  ],
  // Monid's server refuses an API key; browser sign-in is the whole setup.
  fields: [],
  actions: [
    { key: "s", id: MONID_SIGNIN_ACTION, label: "sign in with Monid" },
    // Only once there is a sign-in to forget. The server entry stays, so s brings it back.
    { key: "x", id: MONID_DISCONNECT_ACTION, label: "disconnect", available: monidHasSignIn },
  ],
  status: monidStatus,
};
