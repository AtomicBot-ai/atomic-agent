/**
 * How many connections one download may open. Hugging Face's CDN
 * throttles each connection, not each client: measured from one machine
 * against a catalogue GGUF, a lone stream ran at ~0.1 MB/s where sixteen
 * ran at ~1.8 MB/s. `hf_transfer`, the Hub's own accelerator, opens far
 * more than that.
 */
export const DEFAULT_DOWNLOAD_CONNECTIONS = 16;
export const MAX_DOWNLOAD_CONNECTIONS = 64;

let configuredConnections = DEFAULT_DOWNLOAD_CONNECTIONS;

export function clampDownloadConnections(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DOWNLOAD_CONNECTIONS;
  return Math.min(MAX_DOWNLOAD_CONNECTIONS, Math.max(1, Math.floor(n)));
}

/**
 * Push-in from config load (`localModels.download.connections`), the
 * same pattern `setConfiguredBackendVariant` uses: the downloader sits
 * below the config layer and is reached from the CLI, the TUI and the
 * detached pull worker alike.
 */
export function setDefaultDownloadConnections(n: number): void {
  configuredConnections = clampDownloadConnections(n);
}

/**
 * Explicit option, then the `ATOMIC_AGENT_DOWNLOAD_CONNECTIONS` env
 * override, then the configured default. The env var lets an operator
 * turn parallelism down for one shell (a metered or flaky link) without
 * editing the config file.
 */
export function resolveDownloadConnections(explicit?: number): number {
  if (explicit !== undefined) return clampDownloadConnections(explicit);
  const env = (process.env.ATOMIC_AGENT_DOWNLOAD_CONNECTIONS ?? "").trim();
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return clampDownloadConnections(parsed);
  }
  return configuredConnections;
}
