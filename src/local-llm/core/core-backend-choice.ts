import type { CoreBackendVariant } from "../backend/windows-backend-variant.js";

/** Core's answer to `/backends/llamacpp/catalog`, as far as the agent reads it. */
export interface CoreBackendCatalog {
  recommended: string | null;
  recommended_installed: string | null;
  releases?: Array<{ tag: string; variants: Array<{ id: string; asset?: string }> }>;
}

/**
 * Whether a Core backend id (and its asset name, when known) is the
 * Windows x64 CPU build (`windows-x64-cpu`, `win-cpu-x64`, or a zip named
 * `...windows-x64-cpu.zip`). Never true for an arm64 build: Windows on ARM
 * has one build and it is not this rescue's business.
 */
export function isCoreWindowsCpuBackend(id: string | undefined, asset?: string): boolean {
  if (!id) return false;
  const text = `${id} ${asset ?? ""}`.toLowerCase();
  return /(^|[^a-z])cpu([^a-z]|$)/.test(text) && /win/.test(text) && !/arm64|aarch64/.test(text);
}

/** `<tag>/<backend>` of the catalog's first Windows x64 CPU build, the recommended tag first. */
function findCpuBuild(catalog: CoreBackendCatalog): string | null {
  for (const pick of [catalog.recommended, catalog.recommended_installed]) {
    if (pick && isCoreWindowsCpuBackend(pick.split("/")[1])) return pick;
  }
  const preferredTag = (catalog.recommended ?? catalog.recommended_installed ?? "").split("/")[0];
  const releases = [...(catalog.releases ?? [])].sort((a, b) => Number(b.tag === preferredTag) - Number(a.tag === preferredTag));
  for (const release of releases) {
    const variant = release.variants.find(v => isCoreWindowsCpuBackend(v.id, v.asset));
    if (variant) return `${release.tag}/${variant.id}`;
  }
  return null;
}

/**
 * Which `<tag>/<backend>` the Core install asks for. Core's recommendation,
 * except on Windows x64 with `localModels.managed.coreBackendVariant =
 * "cpu"` (set by the start that found the GPU build crashing on load, or
 * by hand): then the CPU build from the same catalog, so a Core update or
 * "Download again" never puts the crashing GPU build back. `"auto"` keeps
 * the recommendation; `backendVariant` is never read here.
 * Throws when CPU is asked for and the catalog has no CPU build, rather
 * than silently installing a GPU build. Pure.
 */
export function chooseCoreBackend(
  catalog: CoreBackendCatalog,
  preference: CoreBackendVariant,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const recommended = catalog.recommended ?? catalog.recommended_installed;
  if (preference !== "cpu" || platform !== "win32" || arch !== "x64") return recommended;
  const cpu = findCpuBuild(catalog);
  if (!cpu) {
    throw new Error('Atomic Core lists no CPU build for this computer, and localModels.managed.coreBackendVariant is "cpu". Set it to "auto" to install the recommended build.');
  }
  return cpu;
}
