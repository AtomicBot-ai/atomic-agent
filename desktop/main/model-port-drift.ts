/**
 * ATO-1750 — the agent follows the model server to its new port.
 *
 * `atag serve` reads `localModels.managed.port` once, at boot: in managed
 * mode its local address is `http://127.0.0.1:<port>` (src/config
 * load-config.ts), captured in its runtime config, and its llama-server
 * client keeps it. The port in config.json can move while serve runs: the
 * terminal agent's model start moves it off a port someone else holds
 * (src/local-llm/server/port-reclaim.ts, written by
 * src/tui/local-models/local-models-port-clearance.ts), into the
 * config.json the desktop shares with it, or a person sets it by hand. The
 * desktop's next `models start` is a fresh process: it reads the new port
 * and starts the model there. Serve kept calling the old address, where a
 * foreign or older server answered 401.
 *
 * So after every model start the app makes, the port serve reports in
 * /health (`llama.url`, its runtime config) is compared with the one the
 * file names; when they differ, the agent is restarted the way a backend
 * switch restarts it (trigger `switch`, held while a turn runs), and the
 * new agent reads the file as it is.
 *
 * The compare is pure; main.ts wires it to the client and the switch restart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The agent's default managed port (src/config/config-schema.ts), when the file names none. */
const DEFAULT_MANAGED_PORT = 19091;

/** The port of a loopback http address, or null for any other address (a remote server is not ours to follow). */
export function loopbackPort(url: string | null | undefined): number | null {
  if (typeof url !== "string" || !url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return null;
  const port = Number(u.port || 80);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** The managed chat port a config names, or null when it is not in managed mode (external: the address is the person's own). */
export function managedPortIn(cfg: unknown): number | null {
  const lm = (cfg as { localModels?: { mode?: unknown; managed?: { port?: unknown } } } | null)?.localModels;
  if (lm?.mode !== "managed") return null;
  const port = lm.managed?.port;
  if (port === undefined) return DEFAULT_MANAGED_PORT;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * The port the agent should move to, or null when it is where the file
 * says (or either side cannot say). `agentUrl` is serve's own local
 * address (/health `llama.url`).
 */
export function stalePortMove(agentUrl: string | null | undefined, cfg: unknown): { from: number; to: number } | null {
  const to = managedPortIn(cfg);
  const from = loopbackPort(agentUrl);
  if (to === null || from === null || from === to) return null;
  return { from, to };
}

/** config.json of the state directory, parsed; null when it cannot be read. */
export function readStateConfig(stateDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

export interface ModelPortDriftDeps {
  /** agent-cli onModelStarted: called after each model start the app makes. */
  onModelStarted: (fn: () => void) => () => void;
  /** The running agent's state, whether it is another computer's, and its local address (/health `llama.url`). */
  agent: () => { state: string; remote: boolean; llamaUrl: string | null | undefined };
  readConfig: () => unknown;
  /** The switch restart (backend-switch restartAfterSwitch): held while a turn runs, never once the app quits. */
  restart: () => Promise<unknown>;
  say: (line: string) => void;
}

/** Wires the check. Hands back the undo. */
export function wireModelPortDrift(deps: ModelPortDriftDeps): () => void {
  return deps.onModelStarted(() => {
    const a = deps.agent();
    // An agent on its way up reads the file as it is; a remote one runs its own models.
    if (a.state !== "connected" || a.remote) return;
    const move = stalePortMove(a.llamaUrl, deps.readConfig());
    if (!move) return;
    deps.say(`[desktop] local-llm: the model server is on port ${move.to} now, the agent still calls ${move.from}; restarting the agent onto the new port`);
    void deps.restart().catch(() => undefined);
  });
}
