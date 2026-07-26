import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveVersionFilePath } from "./backend-paths.js";

export interface BackendVersionInfo {
  tag: string;
  downloadedAt: string;
  /**
   * Release asset actually installed. On Windows the same
   * `llama-server.exe` ships in a Vulkan and two CUDA zips, so the
   * binary's presence alone cannot tell us which compute backend is on
   * disk. Recording it lets `checkForBackendUpdate` offer a re-download
   * when the machine now warrants a different variant (e.g. the NVIDIA
   * driver was installed after the first Vulkan-only install). Absent on
   * installs predating this field.
   */
  asset?: string;
}

export function readBackendVersion(dataDir: string): BackendVersionInfo | null {
  try {
    const raw = readFileSync(resolveVersionFilePath(dataDir), "utf-8");
    return JSON.parse(raw) as BackendVersionInfo;
  } catch {
    return null;
  }
}

export function writeBackendVersion(dataDir: string, info: BackendVersionInfo): void {
  const p = resolveVersionFilePath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2) + "\n");
}
