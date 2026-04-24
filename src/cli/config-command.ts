import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

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
    "Example:",
    "  atomic-agent config get",
    "  atomic-agent config set '{\"version\":1,\"llama\":{\"url\":\"http://127.0.0.1:19091\"},",
    "                            \"log\":{\"level\":\"info\"},",
    "                            \"agent\":{\"tokenBudget\":3000,\"maxSteps\":25,",
    "                                     \"toolTimeoutMs\":60000,\"approvalRequired\":true}}'",
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
