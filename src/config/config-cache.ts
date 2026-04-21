import { loadConfig } from "./load-config.js";
import type { AtomicAgentConfig } from "./config-schema.js";

let cachedConfig: AtomicAgentConfig | null = null;

export function getConfig(): AtomicAgentConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
