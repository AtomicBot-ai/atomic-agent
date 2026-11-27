/**
 * The folder the downloaded models live in when the operator moved them
 * out of `<dataDir>/models` (ATO-2106), for example onto an external disk.
 *
 * Pushed in by `loadConfig` from `localModels.managed.modelsDirOverride`,
 * the same way the backend variant and the download fan-out reach this
 * config-free layer (`setConfiguredBackendVariant`,
 * `setDefaultDownloadConnections`). `null` means the default folder.
 */
let modelsDirOverride: string | null = null;

export function setModelsDirOverride(dir: string | null): void {
  modelsDirOverride = dir;
}

export function getModelsDirOverride(): string | null {
  return modelsDirOverride;
}
