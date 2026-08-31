import { downloadBackend } from "./backend-installer.js";
import type { DownloadProgressFn } from "./download-file.js";
import { DaemonHealthError, stopChatAndEmbeddingDaemons } from "./daemon-lifecycle.js";
import {
  isWindowsGpuBackendAsset,
  setConfiguredBackendVariant,
  type BackendVariantPreference,
} from "./windows-backend-variant.js";

/**
 * Windows-only escape hatch for machines whose GPU stack cannot actually
 * serve a model — most commonly an iGPU-only box (e.g. AMD 5600G) where
 * the Vulkan build initializes but crashes or hangs on model load, so a
 * `-ngl 0` device override cannot save it: the broken compute backend is
 * baked into the binary. The only fix is swapping the installed zip for
 * the CPU build the turboquant nightly also publishes.
 *
 * `shouldFallBackToCpuBackend` is the pure eligibility decision; the
 * callers (TUI orchestrator, CLI `models start`) own the messaging, the
 * `backendVariant: "cpu"` config persistence, and the single retry.
 */
export function shouldFallBackToCpuBackend(opts: {
  /** `readBackendVersion(dataDir)?.asset` — undefined on old installs. */
  installedAsset: string | undefined;
  /** Configured `localModels.managed.backendVariant`. */
  configuredVariant: BackendVariantPreference;
  /** The error `startDaemon` / `startChatAndEmbeddingDaemons` rejected with. */
  error: unknown;
  platform?: NodeJS.Platform;
}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return false;
  // An operator who pinned a variant made a call — honour it, even when
  // that variant fails. `"cpu"` also lands here: falling back to what is
  // already installed would loop.
  if (opts.configuredVariant !== "auto") return false;
  // Only a health-wait failure implicates the compute backend. A missing
  // model file, a port already bound, or "already running" would fail the
  // CPU build identically.
  if (!(opts.error instanceof DaemonHealthError)) return false;
  return isWindowsGpuBackendAsset(opts.installedAsset);
}

/**
 * Swap the installed Windows backend for the CPU build: flip the
 * in-process variant preference to `"cpu"` (so `resolveDownloadAsset`
 * picks the CPU zip), stop whatever half-started daemon is holding the
 * binary (a hung loader would otherwise wedge the Windows file-lock on
 * the swap), and re-download. Persisting `backendVariant: "cpu"` into
 * the user config is the caller's job — without it the next
 * auto-update's variant-staleness check would reinstall the GPU build
 * and re-break the machine.
 */
export async function fallBackToCpuBackend(
  dataDir: string,
  opts?: {
    onProgress?: DownloadProgressFn;
    signal?: AbortSignal;
  },
): Promise<{ tag: string }> {
  setConfiguredBackendVariant("cpu");
  try {
    await stopChatAndEmbeddingDaemons(dataDir);
  } catch {
    // Best-effort: a foreign or already-dead pid must not block the
    // swap attempt; downloadBackend will surface a real file lock.
  }
  const { tag } = await downloadBackend(dataDir, {
    ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  return { tag };
}
