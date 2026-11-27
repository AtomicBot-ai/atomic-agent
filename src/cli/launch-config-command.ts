/**
 * ATO-2448: the `--config`, `--revert` and `--print-key` paths of
 * `atag launch`. `--config` writes a lasting setting (launch-config.ts)
 * pointed at serve's default port, 8787: a serve that `atag launch`
 * started for one run sits on a random port and stops with that run, so
 * only the port a person's own `atag serve` uses stays valid. A serve that
 * runs now is only asked for the loaded model's name. `--print-key` is
 * what Claude Code's `apiKeyHelper` runs.
 */

import { homedir } from "node:os";

import { isSeaBuild, selfInvocation } from "../runtime/self-invocation.js";
import type { LaunchArgs } from "./launch-args.js";
import { applyLaunchConfig, nodeConfigFs, revertLaunchConfig, type LaunchConfigFs } from "./launch-config.js";
import { persistSpecFor, type PersistInput } from "./launch-config-targets.js";
import { DEFAULT_LAUNCH_MODEL, type LaunchIntegration } from "./launch-integrations.js";
import type { LocalModelProbe } from "./launch-local-model.js";
import { DEFAULT_SERVE_PORT, loopbackBaseUrl, type LaunchServe } from "./launch-serve.js";
import { lastingToken, launchClientKeyPath } from "./launch-token.js";

/** Name of the fallback model label in local mode (same as launch-command.ts). */
const LOCAL_FALLBACK = "local-model";

/** `"<atag>" launch --print-key`, quoted for sh, cmd.exe and PowerShell alike. */
export function printKeyCommand(self: { cmd: string; args: readonly string[] }): string {
  const quote = (part: string): string => (/^[\w@%+=:,./\\-]+$/.test(part) ? part : `"${part}"`);
  return [`"${self.cmd}"`, ...self.args.map(quote), "launch", "--print-key"].join(" ");
}

export interface LaunchConfigDeps {
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly fs?: LaunchConfigFs;
  /** The command that prints the key; defaults to this program's own invocation. */
  readonly keyCommand?: string;
  readonly findServe: (stateDir: string, cwd: string | null) => Promise<LaunchServe | null>;
  readonly probeLocal: (baseUrl: string, token: string) => Promise<LocalModelProbe>;
  readonly cwd: string;
  /** Asks serve for the model name only. */
  readonly key: string;
  /** ATO-2451: the lasting `member` token the CLI's setting reads (launch-token.ts). */
  readonly lastingToken?: (stateDir: string) => { readonly token: string } | { readonly error: string };
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

export async function runLaunchConfig(
  integration: LaunchIntegration,
  parsed: Pick<LaunchArgs, "mode" | "model" | "revert">,
  deps: LaunchConfigDeps,
): Promise<number> {
  const fs = deps.fs ?? nodeConfigFs;
  if (parsed.revert) {
    const undone = revertLaunchConfig(deps.stateDir, integration.id, fs);
    if (!undone.ok) {
      deps.writeErr(`launch: ${undone.error}\n`);
      return 1;
    }
    deps.write(`${undone.lines.join("\n")}\n`);
    return 0;
  }

  const local = parsed.mode === "local";
  const serve = await deps.findServe(deps.stateDir, local ? null : deps.cwd);
  const serveUrl = loopbackBaseUrl(DEFAULT_SERVE_PORT);
  const found = local && serve ? await deps.probeLocal(serve.baseUrl, deps.key) : null;
  const modelId = found?.ok ? found.modelId : null;
  const model = parsed.model ?? (local ? modelId ?? LOCAL_FALLBACK : DEFAULT_LAUNCH_MODEL);
  const keyCommand =
    deps.keyCommand ??
    printKeyCommand(selfInvocation({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv, isSea: isSeaBuild() }));
  const input: PersistInput = {
    baseUrl: local ? `${serveUrl}/local` : serveUrl,
    model,
    modelGiven: local || parsed.model !== null,
    keyCommand,
    keyFile: launchClientKeyPath(deps.stateDir),
    env: deps.env,
    home: deps.home ?? homedir(),
  };
  const spec = persistSpecFor(integration.id, input);
  if (!spec) {
    deps.writeErr(`launch: ${integration.displayName} has no lasting setting; run atag launch ${integration.id} each time instead.\n`);
    return 2;
  }
  // The token the setting points at must exist before the CLI first reads it.
  const lasting = (deps.lastingToken ?? lastingToken)(deps.stateDir);
  if ("error" in lasting) {
    deps.writeErr(`launch: could not save the key for ${integration.displayName} in the Atomic Agent folder; nothing was changed.\n`);
    return 1;
  }
  const applied = applyLaunchConfig(deps.stateDir, integration.id, spec, fs);
  if (!applied.ok) {
    deps.writeErr(`launch: ${applied.error}\n`);
    return 1;
  }
  deps.write(`${applied.lines.join("\n")}\n`);
  deps.write(
    serve?.port === DEFAULT_SERVE_PORT && serve.started === false
      ? `${integration.displayName} now uses the atag serve on port ${DEFAULT_SERVE_PORT}; keep it running.\n`
      : `${integration.displayName} now expects atag serve on port ${DEFAULT_SERVE_PORT}. Start it before using ${integration.displayName} and keep it running: atag serve${local ? "" : " --cwd <your project>"}\n`,
  );
  if (local && !parsed.model && !modelId) {
    deps.write(`The model name is "${LOCAL_FALLBACK}"; run this again while the local model runs to write its real name.\n`);
  }
  return 0;
}
