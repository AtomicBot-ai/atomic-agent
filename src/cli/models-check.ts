import { getConfig } from "../config/index.js";
import { managedPortsOf } from "../llm/describe-llama-health-failure.js";
import {
  recheckLocalConnection,
  type LocalConnectionCheck,
} from "../llm/recheck-local-connection.js";

/** Test seam: the check itself. */
export interface ModelsCheckDeps {
  recheck?: typeof recheckLocalConnection;
}

/**
 * `atomic-agent models check [--json]`: ask `localModels.url` what it is,
 * the same way saving the address does, and print the verdict (ATO-873,
 * variant B). The terminal's half of the desktop's Reconnect button, and
 * the command a failed turn names when the local server answered 404/405.
 * Reads the config, writes nothing: an address on llama.cpp's old 8080
 * default gets a line about 9931, never a rewrite.
 *
 * Exit 0 when a llama.cpp server answers there, 1 for every other
 * verdict, so a script can gate on it. `--json` prints the result object
 * (`url`, `verdict`, `ok`, `message`, `portHint`).
 */
export async function runLocalModelsCheck(
  args: readonly string[],
  deps: ModelsCheckDeps = {},
): Promise<number> {
  const cfg = getConfig();
  const recheck = deps.recheck ?? recheckLocalConnection;
  const result = await recheck({
    url: cfg.localModels.url,
    managedPorts: managedPortsOf(cfg.localModels),
  });
  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(result)}\n` : formatCheck(result),
  );
  return result.ok ? 0 : 1;
}

function formatCheck(result: LocalConnectionCheck): string {
  return [
    `url:            ${result.url}`,
    `verdict:        ${result.verdict}`,
    result.message,
    ...(result.portHint ? [result.portHint] : []),
  ].join("\n") + "\n";
}
