/**
 * ATO-2459: what the four My apps tools share: their options, the
 * approval ask, and the wording of a refusal.
 *
 * The ask is categorised like any file the agent writes under the state
 * dir (`categorizeFsMutation`: `fs_write_home` inside home, `fs_trash`
 * for a delete, `trust_config` never, since `apps/` is not a trust
 * path), so the approval ladder treats "save an app" as it treats "save
 * a file there": asked at levels 1-2, silent from 3, enforced here at
 * dispatch whatever the prompt says.
 */

import { homedir } from "node:os";

import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { categorizeFsMutation, type FsMutationKind } from "../os/fs/fs-approval-scope.js";
import type { ToolContext } from "../tool-registry.js";
import { appsRoot, APP_MAX_BYTES, type AppManifest, type AppRefusal } from "./app-names.js";
import type { ShortcutPlace } from "./app-shortcut-paths.js";

export interface AppToolOptions extends DangerousToolOptions {
  /** The agent's state dir (`config.paths.stateDir`); apps live in `<stateDir>/apps`. */
  stateDir: string;
  /** The agent's trust files, as the fs tools get them (`getTrustConfigPaths`). */
  trustConfigPaths?: readonly string[];
  /** Test seam: the clock. */
  now?: () => number;
  /** Test seam: where an installed app's launcher lives (app-shortcut-paths.ts). */
  shortcutPlace?: ShortcutPlace;
}

export const APP_SAVE_TOOL = "app.save";
export const APP_UPDATE_TOOL = "app.update";
export const APP_DELETE_TOOL = "app.delete";
export const APP_LIST_TOOL = "app.list";

export function appsRootOf(options: AppToolOptions): string {
  return appsRoot(options.stateDir);
}

export function nowOf(options: AppToolOptions): number {
  return options.now ? options.now() : Date.now();
}

export function shortcutPlaceOf(options: AppToolOptions): ShortcutPlace {
  return options.shortcutPlace ?? { platform: process.platform, home: homedir(), env: process.env };
}

/** Ask the gate before a write or a delete under the apps folder. A no throws ApprovalDeniedError. */
export async function askForApp(
  options: AppToolOptions,
  ctx: ToolContext,
  ask: { tool: string; kind: FsMutationKind; path: string; reason: string; preview?: string; app: string },
): Promise<void> {
  const category = await categorizeFsMutation(ask.kind, [ask.path], {
    workingDir: ctx.workingDir,
    ...(options.trustConfigPaths !== undefined ? { trustConfigPaths: options.trustConfigPaths } : {}),
  });
  await requireApproval(
    options,
    {
      sessionId: ctx.sessionId,
      tool: ask.tool,
      category,
      reason: ask.reason,
      ...(ask.preview !== undefined ? { preview: ask.preview } : {}),
      affectedResources: [`app ${ask.app}`],
    },
    ctx.signal,
  );
}

const REFUSALS: Record<AppRefusal, string> = {
  empty: "html is empty: send the whole page, one self-contained HTML file",
  "too-large": `the page is larger than ${APP_MAX_BYTES / (1024 * 1024)} MB, too large to keep as an app`,
  "bad-id": "id is not an app id: take it from app.list",
  "not-found": "no app has that id: call app.list for the ids",
  "write-failed": "the app could not be written to disk",
  "no-version": "that app has no such version: app.list with its id lists the versions",
};

export function appRefusal(tool: string, reason: AppRefusal, field?: string): CompressedToolResult {
  return compressToolResult({
    tool,
    status: "error",
    output: `${field ? `validation: ${field}: ` : ""}${REFUSALS[reason]}`,
    details: { reason, ...(field ? { field } : {}) },
  });
}

export function argError(tool: string, field: string, message: string): CompressedToolResult {
  return compressToolResult({
    tool,
    status: "error",
    output: `validation: ${field}: ${message}`,
    details: { field, reason: message },
  });
}

/** What a result says about one app, the same in every tool. */
export function appDetails(app: AppManifest): Record<string, unknown> {
  return { id: app.id, name: app.name, createdAt: app.createdAt, updatedAt: app.updatedAt, bytes: app.bytes };
}

export function optionalString(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === "string" ? raw : null;
}
