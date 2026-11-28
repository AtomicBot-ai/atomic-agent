import type { ToolSecretSource } from "../config/tool-secrets.js";
import { checkToolSecretNames, fillToolSecretTexts } from "../tools/tool-secret-use.js";
import { McpConnectError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

/**
 * `{{secret:NAME}}` in a remote MCP server's `headers` (ATO-2530), e.g.
 * `"headers": {"Authorization": "Bearer {{secret:LINEAR_TOKEN}}"}`, the
 * Streamable HTTP and SSE twin of a stdio server's `env`
 * (`mcp-env-secrets.ts`), under the same rules:
 *
 * - The person wrote it into their own config, so there is no per-call
 *   approval: the value is fetched when the connection is opened and
 *   goes only into that server's request headers. The model never sees
 *   the headers, and the value is remembered for exact-value masking of
 *   errors and logs.
 * - Only the person's own servers may name a secret (`mayUse`): a server
 *   an installed plugin brings is the plugin author's text, and
 *   `{{secret:GITHUB_TOKEN}}` there must not send the person's token to
 *   the plugin author's URL.
 * - A malformed or unknown name, a server that may not use secrets, a
 *   value that cannot be fetched, or a value with a line break (it would
 *   start a header of its own) keeps that server down with a message
 *   naming the secret, never the value.
 *
 * Precedent: Claude Code's `.mcp.json` expands `${VAR}` in `headers` at
 * connect, Cursor's `${env:NAME}` likewise.
 */
export async function resolveMcpServerHeaders(
  config: McpServerConfig,
  source: ToolSecretSource | undefined,
  mayUse = true,
): Promise<Readonly<Record<string, string>> | undefined> {
  const t = config.transport;
  if (t.kind === "stdio" || t.headers === undefined) return undefined;
  const headers = t.headers;
  const keys = Object.keys(headers);
  const texts = keys.map((key) => headers[key]!);
  const fail = (message: string): never => {
    throw new McpConnectError(config.name, `${message} (in this server's headers). The server was not connected.`);
  };
  const check = checkToolSecretNames(texts, mayUse ? source : undefined);
  if (!mayUse && (!check.ok || check.names.length > 0)) {
    return fail("only a server you added to config.json may use a tool secret, not one an installed plugin brings");
  }
  if (!check.ok) return fail(check.message);
  if (check.names.length === 0 || source === undefined) return headers;
  const filled = await fillToolSecretTexts(texts, check.names, source, { shell: false });
  if (!filled.ok) return fail(filled.message);
  const broken = keys.find((_key, index) => /[\r\n]/.test(filled.texts[index]!));
  if (broken !== undefined) return fail(`the secret in header ${broken} holds a line break, so it is not used`);
  return Object.fromEntries(keys.map((key, index) => [key, filled.texts[index]!]));
}
