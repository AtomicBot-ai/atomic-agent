/**
 * ATO-1656: what the window may send over `importFacts:start`, checked in
 * full before the agent is asked (import-facts.ts builds the agent's body
 * from the result). The IPC payload comes from the renderer, so main trusts
 * none of it: the shape, the source, the path on disk, and the cloud choice
 * are each checked here, and anything else is refused with words the window
 * can show.
 *
 * The path must name what the agent can read (src/import/user-facts/
 * read-chat-export.ts): the data export `.zip` as downloaded, or the folder
 * it was unpacked to (the Claude flow hands over that folder,
 * renderer.js ifactAfterImport). A `.zip` is read whole into memory there,
 * so a size cap stops a path that could never be read from reaching it.
 *
 * Precedent: attachments.ts refuses what is not a regular file and what is
 * over its cap before anything is copied; Claude Code's and Codex's file
 * tools check `stat` and the extension on the host side rather than trust
 * the UI. Pure but for `stat`, which is passed in so the unit test can use
 * both real temp files and a fake for the cap. No Electron import.
 */

import { statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";

export type FactsSource = "claude" | "chatgpt";

/** The .zip is read whole by the agent (JSZip over readFileSync); above this it could not be. */
export const FACTS_EXPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** The only file kind both exports come as; a folder is the unpacked export. */
export const FACTS_EXPORT_EXTENSIONS: readonly string[] = [".zip"];
const PATH_MAX_CHARS = 4096;
const PROVIDER_MAX_CHARS = 120;
const INPUT_KEYS = new Set(["source", "path", "cloud"]);
const CLOUD_KEYS = new Set(["provider", "consent"]);

/** What `stat` must answer; node:fs Stats fits. */
export interface FactsPathInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}
/** Throws when there is no such path, as node:fs statSync does. */
export type FactsStat = (path: string) => FactsPathInfo;

export interface FactsStartInput {
  source: FactsSource;
  path: string;
  /** The cloud model the person ticked for this run; null reads locally. Consent is already checked. */
  cloud: { provider: string } | null;
}

export type FactsInputCheck = { ok: true; input: FactsStartInput } | { ok: false; error: string };

export const FACTS_INPUT_TEXT = {
  notValid: "Could not start reading: the request from the window is not valid.",
  source: "Choose Claude or ChatGPT first.",
  path: "Choose the export .zip first.",
  missing: "That export is not there any more. Choose it again.",
  notZip: "Choose the .zip from the Export data, or the folder it was unpacked to.",
  empty: "That .zip is empty. Download the export again and choose it.",
  kind: "Only a .zip file or a folder can be read.",
  provider: "Choose the cloud model to use.",
  consent: "Tick the box to send your chats to the cloud model, or use the local one.",
} as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasOnlyKeys = (o: Record<string, unknown>, allowed: Set<string>): boolean => Object.keys(o).every((k) => allowed.has(k));
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** "2.3 GB" for the size words. */
export function factsSizeWords(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  if (bytes >= gb) return (bytes / gb).toFixed(1) + " GB";
  return Math.max(1, Math.round(bytes / (1024 * 1024))) + " MB";
}

/** The path on disk: the export .zip (regular file, under the cap) or its folder. */
export function checkFactsExportPath(raw: unknown, stat: FactsStat = statSync): { ok: true; path: string } | { ok: false; error: string } {
  const path = typeof raw === "string" ? raw.trim() : "";
  if (!path || path.length > PATH_MAX_CHARS || CONTROL_CHARS.test(path) || !isAbsolute(path)) return { ok: false, error: FACTS_INPUT_TEXT.path };
  let info: FactsPathInfo;
  try {
    info = stat(path);
  } catch {
    return { ok: false, error: FACTS_INPUT_TEXT.missing };
  }
  if (info.isDirectory()) return { ok: true, path };
  if (!info.isFile()) return { ok: false, error: FACTS_INPUT_TEXT.kind };
  if (!FACTS_EXPORT_EXTENSIONS.includes(extname(path).toLowerCase())) return { ok: false, error: FACTS_INPUT_TEXT.notZip };
  if (!(info.size > 0)) return { ok: false, error: FACTS_INPUT_TEXT.empty };
  if (info.size > FACTS_EXPORT_MAX_BYTES) {
    return {
      ok: false,
      error:
        "That export is " + factsSizeWords(info.size) + "; the agent can read a .zip up to " + factsSizeWords(FACTS_EXPORT_MAX_BYTES)
        + ". Unpack it and choose the folder instead.",
    };
  }
  return { ok: true, path };
}

/**
 * The cloud part of the request: absent, null or false reads locally; an
 * object names the provider and carries the person's tick as a literal
 * boolean true. Any other shape, and any consent that is not `true`, is
 * refused: the tick on this run is the only consent.
 */
export function checkFactsCloud(raw: unknown): { ok: true; cloud: { provider: string } | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === false) return { ok: true, cloud: null };
  if (raw === true) return { ok: false, error: FACTS_INPUT_TEXT.provider };
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, CLOUD_KEYS)) return { ok: false, error: FACTS_INPUT_TEXT.notValid };
  const provider = typeof raw["provider"] === "string" ? raw["provider"].trim() : "";
  if (!provider) return { ok: false, error: FACTS_INPUT_TEXT.provider };
  if (provider.length > PROVIDER_MAX_CHARS || CONTROL_CHARS.test(provider)) return { ok: false, error: FACTS_INPUT_TEXT.notValid };
  const consent = raw["consent"];
  if (typeof consent !== "boolean") return { ok: false, error: FACTS_INPUT_TEXT.notValid };
  if (consent !== true) return { ok: false, error: FACTS_INPUT_TEXT.consent };
  return { ok: true, cloud: { provider } };
}

/** The whole `importFacts:start` payload. Shape first, then source, path on disk, cloud. */
export function checkFactsStartInput(input: unknown, stat: FactsStat = statSync): FactsInputCheck {
  if (!isPlainObject(input) || !hasOnlyKeys(input, INPUT_KEYS)) return { ok: false, error: FACTS_INPUT_TEXT.notValid };
  const source = input["source"];
  if (source !== "claude" && source !== "chatgpt") return { ok: false, error: FACTS_INPUT_TEXT.source };
  const path = checkFactsExportPath(input["path"], stat);
  if (!path.ok) return path;
  const cloud = checkFactsCloud(input["cloud"]);
  if (!cloud.ok) return cloud;
  return { ok: true, input: { source, path: path.path, cloud: cloud.cloud } };
}
