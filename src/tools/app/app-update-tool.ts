import { join } from "node:path";

import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { appDir, cleanAppName, isAppId, pageRefusal } from "./app-names.js";
import { readAppManifest, restoreAppVersion, updateApp, type AppUpdateResult } from "./app-store.js";
import {
  APP_UPDATE_TOOL,
  appDetails,
  appRefusal,
  appsRootOf,
  argError,
  askForApp,
  nowOf,
  optionalString,
  type AppToolOptions,
} from "./app-tool-shared.js";

/**
 * `app.update { id, html?, name?, restoreVersion? }` (ATO-2459): change
 * an app in My apps from the chat ("make the converter show the rate
 * date"). A new page keeps the one it replaces as a version
 * (app-versions.ts), so every edit can be undone with `restoreVersion`
 * or from the desktop's version list. Asks first, like app.save.
 */
export function buildAppUpdateTool(options: AppToolOptions): ToolDefinition {
  return {
    name: APP_UPDATE_TOOL,
    description:
      "Change an app in My apps: a new full page (html), a new name, or an earlier version put back (restoreVersion). The page it replaces is kept as a version.",
    readonly: false,
    async run(rawArgs, ctx) {
      const id = rawArgs.id;
      if (!isAppId(id)) return appRefusal(APP_UPDATE_TOOL, "bad-id", "id");
      const name = optionalString(rawArgs.name);
      if (name === null) return argError(APP_UPDATE_TOOL, "name", "must be a string");
      const html = rawArgs.html;
      const restore = rawArgs.restoreVersion;
      if (html !== undefined && restore !== undefined) {
        return argError(APP_UPDATE_TOOL, "restoreVersion", "send html or restoreVersion, not both");
      }
      if (html === undefined && restore === undefined && name === undefined) {
        return argError(APP_UPDATE_TOOL, "html", "send html, name or restoreVersion");
      }
      if (html !== undefined) {
        const refusal = pageRefusal(html);
        if (refusal) return appRefusal(APP_UPDATE_TOOL, refusal, "html");
      }
      if (restore !== undefined && (typeof restore !== "number" || !Number.isInteger(restore) || restore < 1)) {
        return argError(APP_UPDATE_TOOL, "restoreVersion", "must be a version number from app.list");
      }
      const root = appsRootOf(options);
      const current = readAppManifest(root, id);
      const dir = appDir(root, id);
      if (!current || !dir) return appRefusal(APP_UPDATE_TOOL, "not-found", "id");
      const what =
        restore !== undefined ? `put version ${restore} back` : html !== undefined ? "replace the page" : "rename it";
      await askForApp(options, ctx, {
        tool: APP_UPDATE_TOOL,
        kind: "write",
        path: join(dir, "index.html"),
        reason: `change the app "${current.name}" in My apps: ${what}`,
        ...(name !== undefined ? { preview: `new name: ${cleanAppName(name)}` } : {}),
        app: current.name,
      });
      const now = nowOf(options);
      let r: AppUpdateResult;
      if (restore !== undefined) {
        r = restoreAppVersion(root, id, restore, now);
        if (r.ok && name !== undefined) {
          const renamed = updateApp(root, id, { name }, now);
          r = renamed.ok ? { ...renamed, kept: r.kept, pageChanged: r.pageChanged } : renamed;
        }
      } else {
        r = updateApp(root, id, { ...(html !== undefined ? { html } : {}), ...(name !== undefined ? { name } : {}) }, now);
      }
      if (!r.ok) return appRefusal(APP_UPDATE_TOOL, r.reason, r.reason === "no-version" ? "restoreVersion" : undefined);
      const parts = [
        r.pageChanged ? "page replaced" : html !== undefined || restore !== undefined ? "page unchanged" : null,
        r.kept ? `the previous page is kept as version ${r.kept.version}` : null,
        name !== undefined ? `named "${r.app.name}"` : null,
      ].filter(Boolean);
      return compressToolResult({
        tool: APP_UPDATE_TOOL,
        status: "ok",
        output: `updated ${r.app.id}: ${parts.join("; ")}. An open app window shows it after a reload.`,
        details: {
          ...appDetails(r.app),
          updated: true,
          pageChanged: r.pageChanged,
          ...(r.kept ? { keptVersion: r.kept.version } : {}),
          ...(restore !== undefined ? { restoredVersion: restore } : {}),
        },
      });
    },
  };
}
