/**
 * Built-in MCP server catalog (ATO-1131): a schema check and the
 * helpers the add flows use. Data is in `mcp-catalog-data.ts`, types
 * in `mcp-catalog-types.ts`.
 *
 * A catalog pick does not write config by itself. It produces the same
 * `{ "mcpServers": { "<id>": {...} } }` text a user could paste, so the
 * one validated write path (`parseAddServerJson` + `persistMcpServer`)
 * stays the only way a server lands in `config.json`. Values the user
 * must supply are `<your ...>` placeholders; `findCatalogPlaceholders`
 * lets the add flow refuse a submit that still contains one.
 */
import { MCP_CATALOG_DATA } from "./mcp-catalog-data.js";
import { MCP_SERVER_NAME_RE } from "./mcp-types.js";
import type {
  McpCatalogData,
  McpCatalogEntry,
  McpCatalogServer,
  McpCatalogShelf,
} from "./mcp-catalog-types.js";

export type {
  McpCatalogData,
  McpCatalogEntry,
  McpCatalogInput,
  McpCatalogServer,
  McpCatalogShelf,
  McpCatalogShelfId,
} from "./mcp-catalog-types.js";

/** Matches one `<your ...>` placeholder. */
export const MCP_CATALOG_PLACEHOLDER_RE = /<your [^<>"]+>/g;

/**
 * Entries in display order: grouped by shelf in shelf order, catalog
 * order inside a shelf. Pickers index into this list.
 */
export function listMcpCatalog(
  data: McpCatalogData = MCP_CATALOG_DATA,
): readonly McpCatalogEntry[] {
  const out: McpCatalogEntry[] = [];
  for (const shelf of data.shelves) {
    for (const e of data.entries) if (e.shelf === shelf.id) out.push(e);
  }
  return out;
}

export function mcpCatalogShelves(
  data: McpCatalogData = MCP_CATALOG_DATA,
): readonly McpCatalogShelf[] {
  return data.shelves;
}

export function findMcpCatalogEntry(
  id: string,
  data: McpCatalogData = MCP_CATALOG_DATA,
): McpCatalogEntry | undefined {
  return data.entries.find((e) => e.id === id);
}

/** The pasteable one-line JSON for an entry, placeholders included. */
export function buildMcpCatalogJson(entry: McpCatalogEntry): string {
  return JSON.stringify({ mcpServers: { [entry.id]: entry.server } });
}

/** Every distinct `<your ...>` placeholder left in `text`, in order. */
export function findCatalogPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(MCP_CATALOG_PLACEHOLDER_RE)) seen.add(m[0]);
  return [...seen];
}

/**
 * One sentence for the add flow when a submit still holds placeholders.
 * Null when there are none.
 */
export function describeUnfilledPlaceholders(text: string): string | null {
  const left = findCatalogPlaceholders(text);
  if (left.length === 0) return null;
  return `replace ${left.join(", ")} with your own value before adding`;
}

/**
 * Schema check for catalog data. Returns a list of problems (empty when
 * the data is fine). Used by the catalog test and safe to call at
 * startup; it never throws.
 */
export function validateMcpCatalog(data: McpCatalogData): string[] {
  const problems: string[] = [];
  const shelfIds = new Set<string>();
  for (const s of data.shelves) {
    if (shelfIds.has(s.id)) problems.push(`shelf ${s.id}: duplicate id`);
    shelfIds.add(s.id);
    if (!s.label.trim()) problems.push(`shelf ${s.id}: empty label`);
  }
  const ids = new Set<string>();
  for (const e of data.entries) {
    const at = `entry ${e.id}`;
    if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!MCP_SERVER_NAME_RE.test(e.id)) {
      problems.push(`${at}: id must match ${MCP_SERVER_NAME_RE.source}`);
    }
    if (!e.title.trim()) problems.push(`${at}: empty title`);
    if (!e.description.trim()) problems.push(`${at}: empty description`);
    if (!shelfIds.has(e.shelf)) problems.push(`${at}: unknown shelf ${e.shelf}`);
    if (!isHttps(e.homepage)) problems.push(`${at}: homepage must be https`);
    problems.push(...checkServer(at, e.server));
    problems.push(...checkInputs(at, e));
  }
  return problems;
}

function checkServer(at: string, s: McpCatalogServer): string[] {
  const out: string[] = [];
  const stdio = typeof s.command === "string";
  const http = typeof s.url === "string";
  if (stdio === http) {
    out.push(`${at}: server needs exactly one of command or url`);
    return out;
  }
  if (stdio && (s.url !== undefined || s.headers !== undefined)) {
    out.push(`${at}: a command server takes no url or headers`);
  }
  if (http) {
    if (s.args !== undefined || s.env !== undefined) {
      out.push(`${at}: a url server takes no args or env`);
    }
    // Keys belong in headers or env, never in a URL that ends up in logs.
    if (!isHttps(s.url!) || findCatalogPlaceholders(s.url!).length > 0) {
      out.push(`${at}: url must be https with no placeholder in it`);
    }
  }
  return out;
}

function checkInputs(at: string, e: McpCatalogEntry): string[] {
  const out: string[] = [];
  const used = findCatalogPlaceholders(JSON.stringify(e.server));
  const declared = new Set<string>();
  for (const input of e.inputs) {
    if (declared.has(input.placeholder)) {
      out.push(`${at}: input ${input.placeholder} listed twice`);
    }
    declared.add(input.placeholder);
    if (!used.includes(input.placeholder)) {
      out.push(`${at}: input ${input.placeholder} is not used in server`);
    }
    if (!input.label.trim()) out.push(`${at}: input without a label`);
    if (input.getUrl !== undefined && !isHttps(input.getUrl)) {
      out.push(`${at}: input getUrl must be https`);
    }
    if (input.secret && input.getUrl === undefined) {
      out.push(`${at}: secret input ${input.placeholder} needs a getUrl`);
    }
  }
  for (const p of used) {
    if (!declared.has(p)) out.push(`${at}: placeholder ${p} has no input`);
  }
  return out;
}

function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}
