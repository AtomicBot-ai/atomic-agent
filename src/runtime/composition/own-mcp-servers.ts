/**
 * Which MCP servers are the person's own, so they may use
 * `{{secret:NAME}}` (ATO-2530): one in `config.json` `mcp.servers`, or
 * the Composio server. A server an installed plugin brings never is.
 *
 * Read live, not from the list at start: a server added mid-session
 * (`/mcp add`, desktop Settings > MCP, the integrations hub) is written to
 * `config.json` first and connected after, and must be allowed without a
 * restart (review F2072.2). Plugin servers are only loaded at start, so
 * their names are fixed; a name in both lists stays refused.
 */
export interface OwnMcpServerDeps {
  /** The servers `config.json` lists now (`getConfig().mcp.servers`). */
  liveServers: () => readonly { name: string }[];
  /** Names that are always the person's own (Composio). */
  alwaysOwn: ReadonlySet<string>;
  /** Names of the servers installed plugins brought at start. */
  pluginServerNames: ReadonlySet<string>;
}

export function ownMcpServerCheck(deps: OwnMcpServerDeps): (server: { name: string }) => boolean {
  return (server) => {
    if (deps.pluginServerNames.has(server.name)) return false;
    if (deps.alwaysOwn.has(server.name)) return true;
    return deps.liveServers().some((s) => s.name === server.name);
  };
}
