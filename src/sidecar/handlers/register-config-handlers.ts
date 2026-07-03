import { getConfigFile, patchConfigFile } from "../../runtime-api/index.js";
import type {
  ConfigGetPayload,
  ConfigGetResult,
  ConfigPatchPayload,
  ConfigPatchResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `config.*` — read and shallow-patch the user config file. Backs onto the
 * same `config-service` facade as the HTTP `route-config`. The merge only
 * touches `localModels`, `log`, and `agent`; in-flight loops keep the
 * previously loaded `getConfig()` until restart.
 */
export function registerConfigHandlers(ctx: SidecarHandlerContext): void {
  const { router } = ctx;

  router.register<ConfigGetPayload, ConfigGetResult>("config.get", () =>
    getConfigFile(),
  );

  router.register<ConfigPatchPayload, ConfigPatchResult>(
    "config.patch",
    (request) => patchConfigFile(request.payload.patch),
  );
}
