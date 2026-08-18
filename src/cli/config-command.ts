import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  USER_CONFIG_VERSION,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Copy-pasteable `config set` payload, assembled from the live schema
 * constants so the help text cannot drift from what `parseUserConfigFile`
 * accepts (the previous hand-written example carried `"version":1` and a
 * `llama` key, both long dead). `config-command.test.ts` extracts this
 * exact line from the rendered help and runs it through the real `set`
 * path.
 */
const CONFIG_SET_EXAMPLE = JSON.stringify({
  version: USER_CONFIG_VERSION,
  localModels: { url: "http://127.0.0.1:19091" },
  log: { level: "info" },
});

const HELP =
  [
    "atomic-agent config — manage the user config file",
    "",
    "Location: <stateDir>/config.json (stateDir comes from ATOMIC_AGENT_STATE_DIR",
    "or defaults to ~/.atomic-agent).",
    "",
    "Subcommands:",
    "  get                       Print the whole config file as JSON",
    "  set '<json>'              Replace the whole config file with a JSON payload",
    "",
    "Keys left out of the payload are filled with their defaults; the result is",
    "validated before anything is written.",
    "",
    "Example:",
    "  atomic-agent config get",
    `  atomic-agent config set '${CONFIG_SET_EXAMPLE}'`,
  ].join("\n") + "\n";

export async function configCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "get":
        return handleGet();
      case "set":
        return handleSet(args.slice(1));
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      process.stderr.write(`config ${sub} failed: ${err.message}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`config ${sub} failed: ${message}\n`);
    return 1;
  }
}

function handleGet(): number {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
  return 0;
}

function handleSet(args: string[]): number {
  if (args.length === 0) {
    process.stderr.write("usage: atomic-agent config set '<json>'\n");
    return 1;
  }
  const raw = args.join(" ");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`config set failed: invalid JSON: ${message}\n`);
    return 1;
  }
  const next = parseUserConfigFile(parsed);
  const path = getConfig().paths.userConfigFile;
  writeUserConfigFileSync(path, next);
  resetConfigCache();
  process.stdout.write(`wrote ${path}\n`);
  return 0;
}
