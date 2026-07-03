/**
 * Request/response payload shapes for the `config.*` commands. See
 * [SIDECAR.md](../../../SIDECAR.md) §4.10. The merge only touches
 * `localModels`, `log`, and `agent` — in-flight loops keep the previously
 * loaded config until restart.
 */

import type { UserConfigFile } from "../../config/index.js";

export interface ConfigGetPayload {
  [key: string]: never;
}
export interface ConfigGetResult {
  path: string;
  config: UserConfigFile;
}

export interface ConfigPatchPayload {
  patch: Partial<UserConfigFile>;
}
export interface ConfigPatchResult {
  path: string;
  config: UserConfigFile;
}
