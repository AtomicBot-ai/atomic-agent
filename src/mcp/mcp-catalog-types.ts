/** Types of the built-in MCP server catalog (ATO-1131); see mcp-catalog.ts. */

export type McpCatalogShelfId = "basics" | "dev" | "apps" | "web-growth";

export interface McpCatalogShelf {
  id: McpCatalogShelfId;
  label: string;
}

/** One value the user fills in before the server can be added. */
export interface McpCatalogInput {
  /** Exact `<your ...>` text inside `server` that the value replaces. */
  placeholder: string;
  /** Plain-words name of the value, shown next to the field. */
  label: string;
  /** True for keys and tokens: never echo them back once entered. */
  secret: boolean;
  /** Where to get the key (https only). */
  getUrl?: string;
}

/** Shortcut shape accepted by `parseAddServerJson`. */
export interface McpCatalogServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpCatalogEntry {
  /** Also the `mcp.servers[].name` written on add. */
  id: string;
  title: string;
  description: string;
  shelf: McpCatalogShelfId;
  homepage: string;
  /** Runtime the command needs on PATH (`npx` → node, `uvx` → uv). */
  requires?: "node" | "uv";
  server: McpCatalogServer;
  inputs: McpCatalogInput[];
  /** Short verified note: free tier, key optional, and so on. */
  note?: string;
}

export interface McpCatalogData {
  shelves: McpCatalogShelf[];
  entries: McpCatalogEntry[];
}
