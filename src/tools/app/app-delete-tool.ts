import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { appDir, isAppId } from "./app-names.js";
import { removeAppShortcut } from "./app-shortcut-paths.js";
import { readAppManifest, trashApp } from "./app-store.js";
import {
  APP_DELETE_TOOL,
  appRefusal,
  appsRootOf,
  askForApp,
  nowOf,
  shortcutPlaceOf,
  type AppToolOptions,
} from "./app-tool-shared.js";

/**
 * `app.delete { id }` (ATO-2459): take an app out of My apps. Asks first
 * (`fs_trash`, like moving a file to the Trash). The folder moves to
 * `apps/.trash/` rather than being erased, and the app's OS launcher, if
 * it was installed, goes with it (app-shortcut-paths.ts). An id that is
 * already gone is not an error, so the model can tell "nothing there"
 * from a refusal (as `memory.notes.forget` does).
 */
export function buildAppDeleteTool(options: AppToolOptions): ToolDefinition {
  return {
    name: APP_DELETE_TOOL,
    description: "Remove an app from My apps (and its launcher, if installed). Ask the person before you call it.",
    readonly: false,
    async run(rawArgs, ctx) {
      const id = rawArgs.id;
      if (!isAppId(id)) return appRefusal(APP_DELETE_TOOL, "bad-id", "id");
      const root = appsRootOf(options);
      const dir = appDir(root, id);
      const app = readAppManifest(root, id);
      if (!dir || !app) {
        return compressToolResult({
          tool: APP_DELETE_TOOL,
          status: "ok",
          output: `no app ${id} in My apps; nothing removed`,
          details: { id, removed: false },
        });
      }
      await askForApp(options, ctx, {
        tool: APP_DELETE_TOOL,
        kind: "trash",
        path: dir,
        reason: `remove the app "${app.name}" from My apps`,
        app: app.name,
      });
      const launcher = removeAppShortcut(dir, id, shortcutPlaceOf(options));
      const r = trashApp(root, id, nowOf(options));
      if (!r.ok) return appRefusal(APP_DELETE_TOOL, r.reason);
      return compressToolResult({
        tool: APP_DELETE_TOOL,
        status: "ok",
        output: `removed "${app.name}" (${id}) from My apps${launcher ? " and its launcher" : ""}`,
        details: { id, name: app.name, removed: true, launcherRemoved: launcher },
      });
    },
  };
}
