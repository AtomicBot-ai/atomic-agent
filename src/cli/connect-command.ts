/**
 * `atag connect <service>` (ATO-2464): guided setup for a chat channel.
 * Linear is the first; the shape follows Cline's `cline connect`.
 */

import { getConfig, resolveStateDir } from "../config/index.js";
import { CONNECT_LINEAR_HELP, connectLinear } from "./connect-linear.js";
import { terminalWizardIo, type WizardIo } from "./connect-prompts.js";

const HELP = ["Usage: atag connect <service>", "", "Services:", "  linear    Mention the agent in Linear issues", "", CONNECT_LINEAR_HELP].join("\n");

export interface ConnectCommandDeps {
  openUrl?: (url: string) => Promise<{ ok: boolean }>;
  io?: WizardIo;
}

export async function connectCommand(args: string[], deps: ConnectCommandDeps = {}): Promise<number> {
  const io = deps.io ?? terminalWizardIo();
  const [service, ...rest] = args;
  if (!service || service === "-h" || service === "--help") {
    io.write(`${HELP}\n`);
    return service ? 0 : 2;
  }
  if (service !== "linear") {
    io.write(`Unknown service: ${service}\n${HELP}\n`);
    return 2;
  }
  return connectLinear(rest, {
    io,
    stateDir: resolveStateDir(),
    configPath: getConfig().paths.userConfigFile,
    ...(deps.openUrl ? { openUrl: deps.openUrl } : {}),
  });
}
