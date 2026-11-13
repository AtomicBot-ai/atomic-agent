import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isLocalServerUrl } from "./local-server-url.js";

/**
 * ATO-1148: a project's own cloud model.
 *
 * A project is a chat's working folder (ATO-1146's MVP: a new project is a
 * folder). When a cloud model is picked in the composer's switcher, the
 * pick is remembered for that folder, and every turn of a chat in that
 * folder (new chats included) asks the agent for it with `provider_id` +
 * `provider_model` on `/v1/chat/completions`. The agent runs that turn on
 * it without changing its config or its active model, so other chats keep
 * theirs and nothing waits for a switch or a restart.
 *
 * Cloud only: a local model is one per agent (one server, one loaded
 * model), so it is never stored per folder and the switcher says so.
 *
 * Kept in its own file, `<userData>/project-models.json`, for the same
 * reasons as workspace.json (workspace-pref.ts): prefs.json's writer keeps
 * only its own keys, and the agent's config.json is shared with the
 * terminal and is not per folder.
 */

export interface ProjectModelPick {
  providerId: string;
  model: string;
}

export type ProjectModels = Record<string, ProjectModelPick>;

/** The note the switcher shows on its local model rows. */
export const LOCAL_MODEL_SHARED_NOTE = "Local model is shared by all projects";

const MAX_FOLDERS = 500;

export function projectModelsPath(userData: string): string {
  return join(userData, "project-models.json");
}

/**
 * The key a folder is stored under: trailing separators dropped, and on
 * Windows (case-insensitive paths, either slash) lower-cased with `\`.
 * Not resolved on disk: a renamed folder is a new project.
 */
export function folderKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = dir.trim();
  if (platform === "win32") {
    const win = trimmed.replace(/\//g, "\\").replace(/\\+$/, "");
    return (/^[a-zA-Z]:$/.test(win) ? win + "\\" : win).toLowerCase();
  }
  const posix = trimmed.replace(/\/+$/, "");
  return posix || "/";
}

function validPick(value: unknown): ProjectModelPick | null {
  if (!value || typeof value !== "object") return null;
  const { providerId, model } = value as { providerId?: unknown; model?: unknown };
  if (typeof providerId !== "string" || typeof model !== "string") return null;
  const p = providerId.trim(), m = model.trim();
  if (!p || !m || p.length > 200 || m.length > 400 || /[\r\n\x00]/.test(p + m)) return null;
  return { providerId: p, model: m };
}

/** The folders in a project-models.json body; anything malformed is dropped. Does not touch the disk. */
export function parseProjectModels(text: string): ProjectModels {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const folders = (raw as { folders?: unknown } | null)?.folders;
  if (!folders || typeof folders !== "object" || Array.isArray(folders)) return {};
  const out: ProjectModels = {};
  for (const [dir, value] of Object.entries(folders as Record<string, unknown>)) {
    const pick = validPick(value);
    if (dir && pick) out[dir] = pick;
  }
  return out;
}

export function readProjectModels(userData: string): ProjectModels {
  try {
    return parseProjectModels(readFileSync(projectModelsPath(userData), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Remember `pick` for `dir`, or forget the folder's pick with `null`.
 * Returns the whole map as written, or null when the write failed.
 */
export function writeProjectModel(userData: string, dir: string, pick: ProjectModelPick | null): ProjectModels | null {
  if (!dir.trim()) return null;
  const all = readProjectModels(userData);
  const key = folderKey(dir);
  delete all[key];
  const clean = pick ? validPick(pick) : null;
  if (pick && !clean) return null;
  if (clean) all[key] = clean;
  // Newest last; the oldest folders go first past the cap.
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_FOLDERS))) delete all[old];
  const path = projectModelsPath(userData);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, folders: all }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return all;
  } catch {
    return null;
  }
}

interface ProviderLike {
  id: string;
  kind: string;
  baseUrl?: string;
  url?: string;
}

/** A provider a per-turn model can run on: configured, and not a model on this machine. */
export function isCloudProvider(entry: ProviderLike | undefined): boolean {
  return !!entry && entry.kind !== "llama-server" && !isLocalServerUrl(entry.baseUrl ?? entry.url);
}

/**
 * What a turn sends for the chat's project, or null for the agent's own
 * model: no pick, a pick whose provider is gone or is local, or a remote
 * agent (its config is another machine's; the folder means nothing there).
 */
export function turnModelFor(
  pick: unknown,
  providers: readonly ProviderLike[] | undefined,
  opts: { remote?: boolean } = {},
): ProjectModelPick | null {
  if (opts.remote) return null;
  const clean = validPick(pick);
  if (!clean) return null;
  return isCloudProvider((providers ?? []).find((p) => p.id === clean.providerId)) ? clean : null;
}
