import { mkdirSync } from "node:fs";
import { mapClaudeCodeMcpServer } from "../import/claude-code/map-mcp.js";
import { MCP_SERVER_NAME_MAX_LENGTH, type McpServerConfig } from "../mcp/mcp-types.js";
import { PLUGIN_VAR_NAMES, USER_VAR_RE, userKeyRefs } from "./plugin-keys.js";
import { loadEnabledPlugins } from "./plugin-runtime.js";
import { isPartDisabled, pluginDataDir } from "./plugin-store.js";

export interface PluginMcpServers {
  servers: McpServerConfig[];
  skipped: Array<{ plugin: string; server: string; reason: string }>;
}

/**
 * MCP servers contributed by enabled plugins, mapped through the same
 * validator as the Claude Code importer. A plugin's own `trust` field is
 * dropped, so its tools follow the default MCP approval policy. A stdio
 * server starts a program, so it is skipped until the user allowed code
 * for that plugin (`runsCodeAccepted`).
 *
 * `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` (and the neutral
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`) are expanded in command, args, env,
 * url and headers. Any other `${NAME}` / `${NAME:-default}` is one of the
 * user's keys (from `<data folder>/.env` or the shell): handing it to a
 * plugin's server needs the same consent as running its code, so such a
 * server is skipped until code is allowed, then filled from `env`. A key
 * that is unset with no default skips the server rather than sending the
 * literal text. Server names become `<plugin>-<server>`, cut to the
 * 32-character MCP name limit, so they cannot collide with the user's own.
 */
export function loadPluginMcpServers(
  stateDir: string,
  takenNames: ReadonlySet<string> = new Set(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): PluginMcpServers {
  const servers: McpServerConfig[] = [];
  const skipped: PluginMcpServers["skipped"] = [];
  const used = new Set(takenNames);
  for (const { record, bundle } of loadEnabledPlugins(stateDir).plugins) {
    for (const [serverName, raw] of Object.entries(bundle.mcpServers)) {
      if (isPartDisabled(record, `mcp:${serverName}`)) continue;
      const name = uniqueName(`${bundle.name}-${serverName}`, used);
      if (!name) { skipped.push({ plugin: bundle.name, server: serverName, reason: "no valid server name" }); continue; }
      const dataDir = pluginDataDir(stateDir, bundle.name);
      const keys = userKeyRefs(raw);
      if (keys.length > 0 && record.runsCodeAccepted !== true) {
        skipped.push({ plugin: bundle.name, server: serverName, reason: `reads your keys (${keys.join(", ")}); allow code for this plugin first (atomic-agent plugin allow-code ${bundle.name})` });
        continue;
      }
      const unset: string[] = [];
      const withKeys = keys.length > 0 ? expandUserKeys(raw, env, unset) : raw;
      if (unset.length > 0) {
        skipped.push({ plugin: bundle.name, server: serverName, reason: `needs ${[...new Set(unset)].sort().join(", ")}; set it in ${stateDir}/.env` });
        continue;
      }
      const expanded = expandVars(withKeys, { root: bundle.root, data: dataDir }) as Record<string, unknown>;
      const mapped = mapClaudeCodeMcpServer({ name, raw: expanded });
      if (mapped.kind === "skip") { skipped.push({ plugin: bundle.name, server: serverName, reason: mapped.reason }); continue; }
      // A stdio server is a program started on this computer: only with the user's consent.
      if (mapped.server.transport.kind === "stdio" && record.runsCodeAccepted !== true) {
        skipped.push({ plugin: bundle.name, server: serverName, reason: "runs a local program; allow code for this plugin first (atomic-agent plugin allow-code <name>)" });
        continue;
      }
      if (JSON.stringify(raw).includes("PLUGIN_DATA")) mkdirSync(dataDir, { recursive: true });
      used.add(name);
      const server: McpServerConfig = { ...mapped.server };
      delete server.trust;
      servers.push({ ...server, description: server.description ?? `From plugin ${bundle.name}` });
    }
  }
  return { servers, skipped };
}

/** Make `<plugin>-<server>` a valid, unused MCP server name (kebab-case, max 32). */
export function uniqueName(candidate: string, used: ReadonlySet<string>): string | null {
  let base = candidate.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  base = base.slice(0, MCP_SERVER_NAME_MAX_LENGTH).replace(/-+$/g, "");
  if (base.length < 2) return null;
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = `-${i}`;
    const name = `${base.slice(0, MCP_SERVER_NAME_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(name)) return name;
  }
  return null;
}

/** Fill `${NAME}` / `${NAME:-default}` from `env`; names unset with no default go to `unset`. */
export function expandUserKeys(value: unknown, env: Readonly<Record<string, string | undefined>>, unset: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(USER_VAR_RE, (whole, name: string, fallback: string | undefined) => {
      if (PLUGIN_VAR_NAMES.has(name)) return whole;
      const v = env[name];
      if (v) return v;
      if (fallback !== undefined) return fallback;
      unset.push(name);
      return whole;
    });
  }
  if (Array.isArray(value)) return value.map(v => expandUserKeys(v, env, unset));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandUserKeys(v, env, unset)]));
  }
  return value;
}

const VAR_RE = /\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|PLUGIN_ROOT|PLUGIN_DATA)\}/g;

export function expandVars(value: unknown, vars: { root: string; data: string }): unknown {
  if (typeof value === "string") return value.replace(VAR_RE, (_m, v: string) => (v.endsWith("ROOT") ? vars.root : vars.data));
  if (Array.isArray(value)) return value.map(v => expandVars(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandVars(v, vars)]));
  }
  return value;
}
