import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { appDir, isAppId, type AppManifest } from "./app-names.js";
import { listApps, readApp } from "./app-store.js";
import { listAppVersions } from "./app-versions.js";
import { APP_LIST_TOOL, appDetails, appRefusal, appsRootOf, type AppToolOptions } from "./app-tool-shared.js";

/** The page text one call may carry back; a longer page is cut and says so. */
export const APP_LIST_PAGE_MAX_CHARS = 60_000;

/**
 * Room kept under a local model's step budget for what wraps the page:
 * the compressor's signature line and the untrusted-content fence.
 */
export const APP_LIST_FRAME_CHARS = 1_500;

/**
 * How much of the page one call may carry back. A local (or unknown)
 * model sees each step's results clipped to `localStepChars`
 * (`agent.batchToolResultCharCap`, step-commit.ts), so a page longer
 * than what is left under that budget would reach it with its tail cut
 * and no word that it is incomplete; an edit from it would drop the
 * tail. Under the budget, the cut is ours and is said out loud.
 */
export function appListPageBudget(modelMode: "local" | "cloud" | undefined, localStepChars: number | undefined, headChars: number): number {
  if (modelMode === "cloud" || localStepChars === undefined) return APP_LIST_PAGE_MAX_CHARS;
  return Math.max(0, Math.min(APP_LIST_PAGE_MAX_CHARS, localStepChars - headChars - APP_LIST_FRAME_CHARS));
}

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function line(app: AppManifest, versions: number): string {
  const day = app.updatedAt.slice(0, 10);
  return `${app.id} · "${app.name}" · changed ${day} · ${kb(app.bytes)} · ${versions} earlier version${versions === 1 ? "" : "s"}`;
}

/**
 * `app.list { id? }` (ATO-2459): what is in My apps. Without an id, one
 * line per app (id, name, last change, size, versions). With an id, that
 * app's versions and its current page, so an edit from the chat starts
 * from what is on disk, whoever changed it last (the desktop or another
 * chat). Read-only; the page is the person's own file, but a page may
 * have been pasted from anywhere, so it is framed as data.
 */
export function buildAppListTool(options: AppToolOptions): ToolDefinition {
  return {
    name: APP_LIST_TOOL,
    description:
      "List the apps in My apps, or with an id show one app's versions and its current page (to edit it with app.update).",
    readonly: true,
    untrustedOutput: "a page saved in My apps",
    async run(rawArgs, ctx) {
      const root = appsRootOf(options);
      const id = rawArgs.id;
      if (id === undefined || id === null) {
        const apps = listApps(root);
        const rows = apps.map((a) => ({ app: a, versions: listAppVersions(appDir(root, a.id) ?? "").length }));
        return compressToolResult(
          {
            tool: APP_LIST_TOOL,
            status: "ok",
            output: rows.length ? rows.map((r) => line(r.app, r.versions)).join("\n") : "(no apps in My apps yet)",
            details: { count: rows.length, apps: rows.map((r) => ({ ...appDetails(r.app), versions: r.versions })) },
          },
          { maxSummaryLength: 8_000, maxTailLines: Number.MAX_SAFE_INTEGER },
        );
      }
      if (!isAppId(id)) return appRefusal(APP_LIST_TOOL, "bad-id", "id");
      const got = readApp(root, id);
      if (!got) return appRefusal(APP_LIST_TOOL, "not-found", "id");
      const versions = listAppVersions(appDir(root, id) ?? "");
      const listing = [
        line(got.app, versions.length),
        ...versions.map((v) => `version ${v.version} · saved ${v.savedAt.slice(0, 16).replace("T", " ")} · ${kb(v.bytes)}`),
      ];
      // 120: the longest "current page (first N ...)" line below.
      const budget = appListPageBudget(ctx.modelMode, options.localStepChars?.(), listing.join("\n").length + 120);
      const cut = got.html.length > budget;
      const page = cut ? got.html.slice(0, budget) : got.html;
      const head = [
        ...listing,
        cut
          ? `current page (first ${budget} characters of ${got.html.length}; app.update needs the whole page):`
          : "current page:",
      ];
      return compressToolResult(
        {
          tool: APP_LIST_TOOL,
          status: "ok",
          output: `${head.join("\n")}\n${page}`,
          details: { ...appDetails(got.app), versions, pageChars: got.html.length, pageTruncated: cut },
        },
        { maxSummaryLength: APP_LIST_PAGE_MAX_CHARS + 4_000, maxTailLines: Number.MAX_SAFE_INTEGER },
      );
    },
  };
}
