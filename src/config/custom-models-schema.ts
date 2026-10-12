/**
 * Validation for `localModels.customModels`, the block that holds the
 * models an operator added from Hugging Face. Ported from PR #38 by
 * sachin-detrax and kept out of `config-schema.ts`, which is long enough
 * already; it depends only on `ConfigValidationError` so the two files
 * do not form a cycle.
 *
 * Only the fields the runtime reads are enforced. The rest are cosmetic
 * and defaulted, so a hand-written entry can stay to four lines.
 */

import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigValidationError } from "./config-validation-error.js";
import type { LocalModelDef } from "../local-llm/catalog/models-catalog.js";

/** The id becomes a directory name under `<dataDir>/models/`. */
const CUSTOM_ID_RE = /^custom-[a-z0-9._-]+$/;

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConfigValidationError(field, `expected a non-empty string`);
  }
  return raw;
}

/**
 * Filenames land in a path join under `<dataDir>/models/<id>/` (see
 * `backend-paths.ts`), so they get the same treatment the id gets for
 * becoming a directory name: no separators, no dot-dot, nothing that
 * can climb out of the model's own directory.
 */
function requireSafeFilename(raw: unknown, field: string): string {
  const str = requireString(raw, field);
  if (str.includes("/") || str.includes("\\") || str.startsWith(".")) {
    throw new ConfigValidationError(
      field,
      `expected a bare filename (no path separators, no leading dot), got ${JSON.stringify(str)}`,
    );
  }
  return str;
}

function requireUrl(raw: unknown, field: string): string {
  const str = requireString(raw, field);
  try {
    new URL(str);
  } catch {
    throw new ConfigValidationError(
      field,
      `expected a valid URL, got ${JSON.stringify(raw)}`,
    );
  }
  return str;
}

/**
 * `localPath` of a model registered from disk (issue #631): an absolute
 * path to a `.gguf`. Whether the file still exists is a launch-time
 * question, not a config one — a moved file must not make the whole
 * config unreadable.
 */
function optionalLocalPath(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = requireString(raw, field);
  if (!isAbsolute(str) || !/\.gguf$/i.test(str)) {
    throw new ConfigValidationError(
      field,
      `expected an absolute path to a .gguf file, got ${JSON.stringify(str)}`,
    );
  }
  return str;
}

/**
 * An entry added from disk stores the file twice: `localPath`, and the
 * matching `file://` URL in `huggingFaceUrl`. A build older than config
 * v76 rewrites `customModels` from what it parsed and drops `localPath`
 * on the way, leaving only the URL. Recover the path from it, so the
 * entry keeps launching from the operator's file instead of turning
 * into a "download" of a `file:` URL. Anything that does not come back
 * as an absolute `.gguf` path is left alone; the download refuses
 * `file:` URLs with its own message.
 */
function localPathFromFileUrl(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return undefined;
  }
  return isAbsolute(path) && /\.gguf$/i.test(path) ? path : undefined;
}

function optionalNumber(raw: unknown, field: string, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigValidationError(
      field,
      `expected a non-negative number, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function optionalString(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

export function parseCustomLocalModel(
  raw: unknown,
  field: string,
): LocalModelDef {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object");
  }
  const entry = raw as Record<string, unknown>;
  const id = requireString(entry.id, `${field}.id`);
  if (!CUSTOM_ID_RE.test(id)) {
    throw new ConfigValidationError(
      `${field}.id`,
      `expected /^custom-[a-z0-9._-]+$/, got ${JSON.stringify(id)}`,
    );
  }
  const fileSizeGb = optionalNumber(entry.fileSizeGb, `${field}.fileSizeGb`, 0);
  const supportsVision = entry.supportsVision === true;
  const storedLocalPath = optionalLocalPath(
    entry.localPath,
    `${field}.localPath`,
  );
  const filename = requireSafeFilename(entry.filename, `${field}.filename`);
  const huggingFaceUrl = requireUrl(
    entry.huggingFaceUrl,
    `${field}.huggingFaceUrl`,
  );
  const localPath = storedLocalPath ?? localPathFromFileUrl(huggingFaceUrl);
  const def: LocalModelDef = {
    id: id as LocalModelDef["id"],
    name: optionalString(entry.name, id),
    filename,
    huggingFaceUrl,
    fileSizeGb,
    sizeLabel: optionalString(entry.sizeLabel, `${fileSizeGb.toFixed(1)} GB`),
    description: optionalString(entry.description, "Custom model"),
    maxContextLength: optionalNumber(
      entry.maxContextLength,
      `${field}.maxContextLength`,
      0,
    ),
    contextLabel: optionalString(entry.contextLabel, "auto"),
    minRamGb: optionalNumber(entry.minRamGb, `${field}.minRamGb`, 1),
    recommendedRamGb: optionalNumber(
      entry.recommendedRamGb,
      `${field}.recommendedRamGb`,
      2,
    ),
    family: "custom",
    supportsVision,
    ...(localPath !== undefined ? { localPath } : {}),
  };
  if (!supportsVision) return def;
  return {
    ...def,
    mmprojUrl: requireUrl(entry.mmprojUrl, `${field}.mmprojUrl`),
    mmprojFilename: requireSafeFilename(
      entry.mmprojFilename,
      `${field}.mmprojFilename`,
    ),
    mmprojFileSizeGb: optionalNumber(
      entry.mmprojFileSizeGb,
      `${field}.mmprojFileSizeGb`,
      0,
    ),
  };
}

export function parseCustomLocalModels(
  raw: unknown,
  field: string,
): LocalModelDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new ConfigValidationError(field, "expected an array");
  const parsed = raw.map((entry, i) =>
    parseCustomLocalModel(entry, `${field}[${i}]`),
  );
  const seen = new Set<string>();
  for (const def of parsed) {
    if (seen.has(def.id)) {
      throw new ConfigValidationError(
        field,
        `duplicate custom model id: ${def.id}`,
      );
    }
    seen.add(def.id);
  }
  return parsed;
}
