import type { ToolSecretSource } from "../config/tool-secrets.js";
import { checkToolSecretNames, fillToolSecretTexts } from "../tools/tool-secret-use.js";
import { McpConnectError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

/**
 * `{{secret:NAME}}` in a stdio MCP server's `env` (ATO-2530), e.g.
 * `"env": {"GITHUB_TOKEN": "{{secret:GITHUB_TOKEN}}"}`, so the key lives
 * in a vault (`toolSecrets` of `secret-sources.json`) instead of in
 * `config.json`. The person wrote it into their own config, so there is
 * no per-call approval: the value is fetched when the server process
 * is about to start and goes only into that process's environment. The
 * model never sees the env block, and the value is remembered for the
 * exact-value masking of tool output, errors and logs. Precedent: the
 * `${VAR}` expansion of Claude Code's `.mcp.json` and Cursor's
 * `${env:NAME}`, both filled in at spawn; 1Password `op run`.
 *
 * Only the person's own servers may name a secret (`mayUse`): a server
 * an installed plugin brings is the plugin author's text, and naming
 * `{{secret:GITHUB_TOKEN}}` there must not hand it the person's token.
 *
 * A malformed or unknown name, a server that may not use secrets, or a
 * value that cannot be fetched keeps that server down with a message
 * naming the secret, never the value. Other servers are unaffected.
 */
export async function resolveMcpServerEnv(
  config: McpServerConfig,
  source: ToolSecretSource | undefined,
  mayUse = true,
): Promise<Readonly<Record<string, string>> | undefined> {
  const env = config.env;
  if (env === undefined || config.transport.kind !== "stdio") return env;
  const keys = Object.keys(env);
  const texts = keys.map((key) => env[key]!);
  const fail = (message: string): never => {
    throw new McpConnectError(config.name, `${message} (in this server's env). The server was not started.`);
  };
  const check = checkToolSecretNames(texts, mayUse ? source : undefined);
  if (!mayUse && (!check.ok || check.names.length > 0)) {
    return fail("only a server you added to config.json may use a tool secret, not one an installed plugin brings");
  }
  if (!check.ok) return fail(check.message);
  if (check.names.length === 0 || source === undefined) return env;
  const filled = await fillToolSecretTexts(texts, check.names, source, { shell: false });
  if (!filled.ok) return fail(filled.message);
  return Object.fromEntries(keys.map((key, index) => [key, filled.texts[index]!]));
}
