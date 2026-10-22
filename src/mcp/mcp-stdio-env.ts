/**
 * The environment a stdio MCP server is spawned with (ATO-346).
 *
 * The agent's own `process.env` is not safe to hand over: bootstrap loads
 * `<stateDir>/.env` into it, so it carries every provider key
 * (`OPENAI_API_KEY`, `EXA_API_KEY`, ...) and bot token configured here.
 * A third-party server needs none of them. Like the official MCP SDKs
 * (`DEFAULT_INHERITED_ENV_VARS`), a server gets only the variables a
 * process needs to start, find its tools and reach the network, plus
 * the `env` block of its own config entry, which wins on collision. A
 * server that needs a key gets it from that block.
 *
 * One list for every platform: a name that does not exist on the host
 * simply is not copied. Names match without regard to case, because
 * Windows environment names are case-insensitive (`Path`, `ComSpec`).
 */
export const MCP_INHERITED_ENV_VARS: readonly string[] = [
  // POSIX: identity, shell, locale, temp dir.
  "HOME",
  "LOGNAME",
  "USER",
  "SHELL",
  "PATH",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_COLLATE",
  "LC_TIME",
  "TZ",
  "TMPDIR",
  "__CF_USER_TEXT_ENCODING",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // A headed browser (Playwright, Puppeteer servers) on Linux needs the
  // display; git over SSH needs the agent socket (a path, not a key: the
  // server can already read ~/.ssh as the user).
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "SSH_AUTH_SOCK",
  // Servers launched as `docker run -i ...` against Colima, OrbStack or a
  // remote engine.
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  // Windows: profile, system dirs, and what `cmd.exe /c` needs to resolve
  // a bare `npx` (see `resolveStdioCommand`).
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "COMPUTERNAME",
  "PSMODULEPATH",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
  "OS",
  // Network: proxies and extra CA bundles, without which a server behind
  // a corporate proxy cannot reach anything.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

const INHERITED = new Set(MCP_INHERITED_ENV_VARS.map((name) => name.toUpperCase()));

/**
 * Build the child environment for a stdio MCP server: the allowlisted
 * variables from `base`, then the server's own configured `env`.
 *
 * Values starting with `()` are skipped, as the SDK does: they are
 * exported shell functions, which a child shell would execute.
 */
export function buildMcpStdioEnv(
  serverEnv: Readonly<Record<string, string>> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string" || value.startsWith("()")) continue;
    if (INHERITED.has(key.toUpperCase())) env[key] = value;
  }
  if (serverEnv) Object.assign(env, serverEnv);
  return env;
}
