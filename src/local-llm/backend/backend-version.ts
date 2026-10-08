import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readCoreBackend, type ManagedEngine } from "../core/core-state.js";

import { resolveVersionFilePath } from "../backend-paths.js";

export interface BackendVersionInfo {
  tag: string;
  downloadedAt: string;
  /**
   * Release asset actually installed. On Windows the same
   * `llama-server.exe` ships in a Vulkan, two CUDA and a CPU zip, so the
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
  /**
   * ATO-244: the Windows CUDA zip this install was meant to be, refused
   * because the release shipped it without its CUDA runtime (no
   * `cudart64_*.dll` next to `ggml-cuda.dll`), and the release tag it
   * came from. The Vulkan build was installed instead. While the newest
   * release is still that tag, the variant-staleness check accepts the
   * Vulkan install as the answer to "this machine wants that CUDA zip" —
   * otherwise every start would download the broken zip again, refuse it
   * again and reinstall Vulkan. A newer tag is an update anyway, and
   * that update tries the CUDA zip afresh.
   */
  refusedCudaAsset?: { asset: string; tag: string };
}

export function readBackendVersion(dataDir: string, engine?: ManagedEngine): BackendVersionInfo | null {
  if (engine === "atomic-core") {
    const backend = readCoreBackend(dataDir);
    return backend ? { tag: `Atomic Core ${backend.coreVersion} · ${backend.version}`, downloadedAt: backend.installedAt, asset: backend.backend } : null;
  }
  try {
    const raw = readFileSync(resolveVersionFilePath(dataDir), "utf-8");
    return JSON.parse(raw) as BackendVersionInfo;
  } catch {
    return null;
  }
}

export function writeBackendVersion(
  dataDir: string,
  info: BackendVersionInfo,
): void {
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
