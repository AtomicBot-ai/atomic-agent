import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { DESKTOP_STATE_DIR } from "./state-dir.js";

/**
 * The bearer key the desktop sends when it talks to a local llama-server
 * itself (`/props` for the context window, the custom-URL probe).
 *
 * The agent launches its managed daemons with a key it keeps in
 * `<models dir>/llama-server.key` (src/local-llm/backend-paths.ts
 * `resolveApiKeyFilePath`, issue #582) and answers 401 to anyone who does
 * not send it. The rule here is the agent's own (`resolveLocalLlamaApiKey`):
 *   1. `ATOMIC_AGENT_LLAMA_API_KEY`, when set, always;
 *   2. otherwise, for a loopback address on a managed port, the key file
 *      when it exists;
 *   3. otherwise no key. A server elsewhere never gets the managed key.
 * The file is only read, never created: a daemon that is running has
 * written it, and an agent without that change has no file and wants no key.
 */

/** The agent's defaults (src/config/config-schema.ts). */
const DEFAULT_MANAGED_PORT = 19091;
const DEFAULT_EMBEDDING_PORT = 19092;

const KEY_FILE = "llama-server.key";

/**
 * The managed daemons' data dir as the CLI resolves it (src/config/load-config.ts:
 * `localModels.managed.dataDirOverride`, else `<stateDir>/models`; `~` is the
 * home directory, a relative path is taken from this process's directory, which
 * the CLI children inherit).
 */
export function managedDataDir(override: string | null | undefined): string {
  const raw = typeof override === "string" ? override.trim() : "";
  if (!raw) return join(DESKTOP_STATE_DIR, "models");
  if (raw.startsWith("~")) return resolvePath(homedir(), raw.slice(2));
  return resolvePath(raw);
}

/** True when `url` is a loopback address on one of `ports`. */
export function isLoopbackOnPort(url: string, ports: readonly number[]): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const loopback =
      host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
    return loopback && ports.map(String).includes(parsed.port);
  } catch {
    return false;
  }
}

/** The key in `<dataDir>/llama-server.key`, or null when there is no usable one. */
export function readManagedKeyFile(dataDir: string): string | null {
  try {
    const key = readFileSync(join(dataDir, KEY_FILE), "utf8").trim();
    return key && !/[\s,]/.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** The pure choice, so the suite can drive it without a config file. */
export function pickLocalLlamaKey(inputs: {
  url: string;
  envKey: string | null | undefined;
  managedPorts: readonly number[];
  dataDir: string;
}): string | null {
  if (inputs.envKey) return inputs.envKey;
  if (!isLoopbackOnPort(inputs.url, inputs.managedPorts)) return null;
  return readManagedKeyFile(inputs.dataDir);
}

/** The managed ports and data dir `<stateDir>/config.json` names, with the agent's defaults. */
function managedSideFromFile(): { ports: number[]; dataDir: string } {
  let managed: { port?: unknown; dataDirOverride?: unknown } | undefined;
  let embeddings: { port?: unknown } | undefined;
  try {
    const cfg = JSON.parse(readFileSync(join(DESKTOP_STATE_DIR, "config.json"), "utf8")) as {
      localModels?: { managed?: typeof managed; embeddings?: typeof embeddings };
    };
    managed = cfg.localModels?.managed;
    embeddings = cfg.localModels?.embeddings;
  } catch {
    // no file yet: the agent's defaults
  }
  const port = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    ports: [port(managed?.port, DEFAULT_MANAGED_PORT), port(embeddings?.port, DEFAULT_EMBEDDING_PORT)],
    dataDir: managedDataDir(typeof managed?.dataDirOverride === "string" ? managed.dataDirOverride : null),
  };
}

/** The key to send to the llama-server at `url`, or null for none. */
export function localLlamaKeyFor(url: string): string | null {
  const envKey = process.env["ATOMIC_AGENT_LLAMA_API_KEY"] || null;
  if (envKey) return envKey;
  const { ports, dataDir } = managedSideFromFile();
  return pickLocalLlamaKey({ url, envKey: null, managedPorts: ports, dataDir });
}
