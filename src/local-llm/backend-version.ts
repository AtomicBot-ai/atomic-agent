import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  /**
   * `published_at` (falling back to `created_at`) of the GitHub release
   * this install came from, ISO-8601. `checkForBackendUpdate` compares
   * it against the resolved release so a re-published or backfilled
   * older tag cannot present itself as an upgrade. Absent on installs
   * predating this field, which is treated as "unknown, allow the
   * tag-difference verdict to stand" so those users still get one more
   * update.
   */
  releasedAt?: string;
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
  writeVersionFile(resolveVersionFilePath(dataDir), info);
}

/**
 * Write the version record into an arbitrary backend directory rather
 * than the live one. The version file lives *inside* `backend/`, so a
 * staged install must carry its own copy — writing it to the live path
 * before the swap would describe a build that is not on disk yet, and
 * writing it after would leave a window where the swapped-in binary is
 * described by the previous tag.
 */
export function writeBackendVersionAt(
  backendDir: string,
  info: BackendVersionInfo,
): void {
  writeVersionFile(join(backendDir, "backend-version.json"), info);
}

function writeVersionFile(p: string, info: BackendVersionInfo): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2) + "\n");
}
