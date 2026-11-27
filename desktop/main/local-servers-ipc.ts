/**
 * ATO-2489: the route behind "Found running on this computer", in the setup
 * step and in Settings › Local (renderer/local-servers.js).
 *
 *   localServers:detect  {ok, servers} from `atag local-servers --json`: the
 *                        core's detectLocalServers (Ollama on 11434, LM Studio
 *                        on 1234, the Llama app / llama-server on 9931), so the
 *                        app, the terminal and the TUI setup see the same thing.
 *
 * View-only: one GET per server on 127.0.0.1, nothing written. Connecting a
 * found server goes through the paths the app already has (the Ollama / LM
 * Studio presets, the External llama-server address).
 *
 * While the app runs chats on an agent on another computer, the servers that
 * matter are over there, so this answers `remote` and the UI draws nothing.
 * An agent without the command (an older core) answers `unsupported`: hidden too.
 */

import { ipcMain } from "electron";

import { atagRun } from "./agent-cli.js";
import { isUnsupportedCommand, parseLocalServers, type LocalServersAnswer } from "./local-servers.js";

export interface LocalServersIpcDeps {
  isRemote: () => boolean;
}

/** The probes take under a second; the rest is the agent binary starting. */
const DETECT_TIMEOUT_MS = 15_000;

export async function detectLocalServersNow(deps: LocalServersIpcDeps): Promise<LocalServersAnswer> {
  if (deps.isRemote()) return { ok: false, remote: true, error: "The app runs chats on another computer." };
  const res = await atagRun(["local-servers", "--json"], DETECT_TIMEOUT_MS).catch(() => null);
  if (!res) return { ok: false, error: "Could not ask the agent." };
  if (!res.ok) {
    return isUnsupportedCommand(res.stderr)
      ? { ok: false, unsupported: true, error: "This agent cannot look for running servers yet." }
      : { ok: false, error: "Could not look for running servers." };
  }
  const servers = parseLocalServers(res.stdout);
  return servers ? { ok: true, servers } : { ok: false, error: "Could not look for running servers." };
}

export function wireLocalServersIpc(deps: LocalServersIpcDeps): void {
  ipcMain.handle("localServers:detect", () => detectLocalServersNow(deps));
}
