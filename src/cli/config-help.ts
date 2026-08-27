import { USER_CONFIG_VERSION } from "../config/index.js";

/**
 * Help text for `atomic-agent config`, kept beside the command rather
 * than inside it so `config-command.ts` stays within the 300-line limit
 * and holds only command behaviour.
 */

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

/**
 * Key/value example, also extracted and executed by the test suite for
 * the same rot-proofing reason as `CONFIG_SET_EXAMPLE`.
 */
const CONFIG_SET_KEY_EXAMPLE = "agent.maxSteps 40";

export const HELP =
  [
    "atomic-agent config — manage the user config file",
    "",
    "Location: <stateDir>/config.json (stateDir comes from ATOMIC_AGENT_STATE_DIR",
    "or defaults to ~/.atomic-agent).",
    "",
    "Subcommands:",
    "  get                       Print the whole config file as JSON",
    "  get <key>                 Print one value by dotted key",
    "  set <key> <value>         Set one value, leaving the rest of the file alone",
    "  set '<json>'              Replace the whole config file with a JSON payload",
    "  unset <key>               Restore one key to its default",
    "  list                      Print every key as `key = value`",
    "  path                      Print the path to the config file",
    "",
    "Values are typed by the config schema, so `false`, `40` and `info` are",
    "written as boolean, number and string respectively; bounds and enums are",
    "enforced before anything is written. Keys left out of a whole-file JSON",
    "payload are filled with their defaults.",
    "",
    "List-valued keys (for example projects.roots) have no single-value spelling —",
    "set those with the whole-file JSON form. `unset` works on them.",
    "",
    "Example:",
    "  atomic-agent config get",
    `  atomic-agent config set ${CONFIG_SET_KEY_EXAMPLE}`,
    `  atomic-agent config set '${CONFIG_SET_EXAMPLE}'`,
  ].join("\n") + "\n";
