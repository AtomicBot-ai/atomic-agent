/**
 * ATO-27 — more local models than the curated list, from a source that
 * is not this file's code: a JSON catalog the operator drops in the
 * state directory, and/or one fetched from a URL. The URL defaults to
 * our own hosted JSON (`DEFAULT_EXTERNAL_CATALOG_URL`, this format);
 * `ATOMIC_AGENT_MODEL_CATALOG_URL` overrides it. Until the site hosts
 * that file the default answers 404, and a refresh then keeps what it
 * had (the curated list) without reporting an error.
 *
 * File format (`models-catalog.json`, or what the URL returns):
 *
 *   { "version": 1, "models": [ {
 *       "id": "qwen3-14b-q4",               // [a-z0-9._-], becomes custom-catalog-<id>
 *       "name": "Qwen3 14B",
 *       "huggingFaceUrl": "https://huggingface.co/<repo>/resolve/<rev>/<file>.gguf",
 *       "fileSizeGb": 9.0,                  // decimal GB of the weights
 *       "minRamGb": 11, "recommendedRamGb": 16,
 *       "vramGb": 10,                       // optional: GPU memory it wants
 *       "description": "…", "maxContextLength": 32768,
 *       "mmprojUrl": "https://huggingface.co/…/mmproj-F16.gguf", "mmprojFileSizeGb": 0.9
 *   } ] }
 *
 * Validation is strict and per entry: a bad entry is dropped with a
 * reason, the others load. Weights must come from Hugging Face over
 * https as a single `.gguf` file; nothing in an entry can name a local
 * path, a chat template file or a recommendation rank, so a catalog
 * can add rows but never change how the curated ones are chosen.
 * Entries carry no `recommendRank`, so they are never recommended or
 * auto-downloaded; a person has to pick one.
 *
 * Every entry also gets a compatibility mark for the current machine
 * (`catalogCompatibility`), from the same fit rule the Hugging Face quant
 * list uses (`quant-fit.ts`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isFullPrecisionGguf, isMmprojFile, isShardedGguf } from "./huggingface-fit.js";
import type { MachineForModels } from "./model-upgrade.js";
import type { LocalModelDef, LocalModelId } from "./models-catalog.js";
import {
  forecastDecodeSpeed,
  activeShareFromName,
  quantFitFor,
  type QuantFit,
  type SpeedForecast,
} from "./quant-fit.js";

export const EXTERNAL_CATALOG_VERSION = 1;
/** The operator's own catalog file, in the state directory. */
export const EXTERNAL_CATALOG_FILENAME = "models-catalog.json";
/** Last good answer of the configured URL, in the state directory. */
export const EXTERNAL_CATALOG_CACHE_FILENAME = "models-catalog.cache.json";
/** Overrides the default catalog URL. */
export const EXTERNAL_CATALOG_URL_ENV = "ATOMIC_AGENT_MODEL_CATALOG_URL";
/**
 * Our own hosted catalog, in the format above (ATO-27). Hosted by the
 * site (atomicagent.io); a 404 or 410 from it means "not published yet".
 */
export const DEFAULT_EXTERNAL_CATALOG_URL = "https://atomicagent.io/models/catalog.json";
/** Ids of catalog entries; the `custom-` prefix keeps the typed id wall. */
export const EXTERNAL_ID_PREFIX = "custom-catalog-";

export const MAX_CATALOG_BYTES = 512 * 1024;
export const MAX_CATALOG_ENTRIES = 200;
export const CATALOG_FETCH_TIMEOUT_MS = 10_000;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HF_HOSTS = new Set(["huggingface.co", "hf.co"]);

export interface ExternalCatalog {
  entries: LocalModelDef[];
  /** One line per dropped entry or unreadable source, for the CLI to show. */
  rejected: string[];
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > max) return null;
  // No control characters: these strings are printed in terminals.
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}

function positive(raw: unknown, max: number): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= max
    ? raw
    : null;
}

/** An https Hugging Face URL of one `.gguf` file, and that file's name. */
function hfGgufUrl(raw: unknown): { url: string; filename: string } | null {
  const value = text(raw, 1024);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !HF_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!/^[^/\\]+\.gguf$/i.test(filename) || filename.startsWith(".")) return null;
  return { url: url.toString(), filename };
}

function sizeLabel(gb: number): string {
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1000)} MB`;
}

/** One entry, or the reason it was dropped. */
export function parseExternalEntry(
  raw: unknown,
  where: string,
): LocalModelDef | string {
  if (!isRecord(raw)) return `${where}: not an object`;
  const slug = typeof raw.id === "string" ? raw.id : "";
  if (!ID_RE.test(slug)) return `${where}: id must match ${ID_RE}`;
  const at = `${where} (${slug})`;
  const name = text(raw.name, 120);
  if (!name) return `${at}: name is missing or too long`;
  const weights = hfGgufUrl(raw.huggingFaceUrl);
  if (!weights) return `${at}: huggingFaceUrl must be an https huggingface.co link to one .gguf file`;
  if (isMmprojFile(weights.filename) || isShardedGguf(weights.filename) || isFullPrecisionGguf(weights.filename)) {
    return `${at}: ${weights.filename} is not a single quantised model file`;
  }
  const fileSizeGb = positive(raw.fileSizeGb, 1000);
  if (fileSizeGb === null) return `${at}: fileSizeGb must be a number in GB`;
  const minRamGb = positive(raw.minRamGb, 4096);
  const recommendedRamGb = positive(raw.recommendedRamGb, 4096);
  if (minRamGb === null || recommendedRamGb === null || minRamGb > recommendedRamGb) {
    return `${at}: minRamGb and recommendedRamGb must be numbers, min ≤ recommended`;
  }
  const vramGb = raw.vramGb === undefined ? undefined : positive(raw.vramGb, 4096);
  if (vramGb === null) return `${at}: vramGb must be a number in GB`;
  const maxContextLength =
    raw.maxContextLength === undefined ? 0 : positive(raw.maxContextLength, 10_000_000);
  if (maxContextLength === null || !Number.isInteger(maxContextLength)) {
    return `${at}: maxContextLength must be a whole number`;
  }
  const description = raw.description === undefined ? null : text(raw.description, 300);
  if (raw.description !== undefined && description === null) {
    return `${at}: description is too long`;
  }

  const def: LocalModelDef = {
    id: `${EXTERNAL_ID_PREFIX}${slug}` as LocalModelId,
    name,
    filename: weights.filename,
    huggingFaceUrl: weights.url,
    fileSizeGb,
    sizeLabel: sizeLabel(fileSizeGb),
    description: description ?? "From an external model catalog",
    maxContextLength,
    contextLabel: maxContextLength > 0 ? `${Math.round(maxContextLength / 1024)}K` : "auto",
    minRamGb: Math.ceil(minRamGb),
    recommendedRamGb: Math.ceil(recommendedRamGb),
    family: "custom",
    supportsVision: false,
    ...(vramGb !== undefined ? { vramGb } : {}),
  };
  if (raw.mmprojUrl === undefined) return def;
  const mmproj = hfGgufUrl(raw.mmprojUrl);
  const mmprojFileSizeGb = positive(raw.mmprojFileSizeGb, 100);
  if (!mmproj || mmprojFileSizeGb === null) {
    return `${at}: mmprojUrl must be an https huggingface.co .gguf link with mmprojFileSizeGb`;
  }
  return {
    ...def,
    supportsVision: true,
    mmprojUrl: mmproj.url,
    mmprojFilename: mmproj.filename,
    mmprojFileSizeGb,
  };
}

/** A whole catalog document. Never throws. */
export function parseExternalCatalog(raw: unknown, source: string): ExternalCatalog {
  if (!isRecord(raw)) return { entries: [], rejected: [`${source}: not a JSON object`] };
  if (raw.version !== EXTERNAL_CATALOG_VERSION) {
    return {
      entries: [],
      rejected: [`${source}: version must be ${EXTERNAL_CATALOG_VERSION}`],
    };
  }
  if (!Array.isArray(raw.models)) return { entries: [], rejected: [`${source}: models must be a list`] };
  const entries: LocalModelDef[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  raw.models.slice(0, MAX_CATALOG_ENTRIES).forEach((item, index) => {
    const parsed = parseExternalEntry(item, `${source} models[${index}]`);
    if (typeof parsed === "string") rejected.push(parsed);
    else if (seen.has(parsed.id)) rejected.push(`${source} models[${index}]: duplicate id`);
    else {
      seen.add(parsed.id);
      entries.push(parsed);
    }
  });
  if (raw.models.length > MAX_CATALOG_ENTRIES) {
    rejected.push(`${source}: only the first ${MAX_CATALOG_ENTRIES} models are read`);
  }
  return { entries, rejected };
}

/** Read and parse one catalog file; a missing file is an empty catalog. */
export function readExternalCatalogFile(path: string): ExternalCatalog {
  if (!existsSync(path)) return { entries: [], rejected: [] };
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    return { entries: [], rejected: [`${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (Buffer.byteLength(body) > MAX_CATALOG_BYTES) {
    return { entries: [], rejected: [`${path}: larger than ${MAX_CATALOG_BYTES} bytes`] };
  }
  try {
    return parseExternalCatalog(JSON.parse(body), path);
  } catch {
    return { entries: [], rejected: [`${path}: not valid JSON`] };
  }
}

/**
 * The operator's file and the URL's cached answer, merged: the file
 * wins on a shared id. This is what config load publishes; it does no
 * network IO.
 */
export function loadExternalCatalog(stateDir: string): ExternalCatalog {
  const own = readExternalCatalogFile(join(stateDir, EXTERNAL_CATALOG_FILENAME));
  const cached = readExternalCatalogFile(join(stateDir, EXTERNAL_CATALOG_CACHE_FILENAME));
  const ids = new Set(own.entries.map((e) => e.id));
  return {
    entries: [...own.entries, ...cached.entries.filter((e) => !ids.has(e.id))],
    rejected: [...own.rejected, ...cached.rejected],
  };
}

/**
 * The catalog URL: the override in `ATOMIC_AGENT_MODEL_CATALOG_URL`, or
 * our own when it is unset or blank. An override that is not https is
 * refused (`null`) rather than silently swapped for the default.
 */
export function externalCatalogUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[EXTERNAL_CATALOG_URL_ENV]?.trim();
  if (!raw) return DEFAULT_EXTERNAL_CATALOG_URL;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface RefreshResult {
  /** The catalog now in the cache (fresh, or the previous one on failure). */
  catalog: ExternalCatalog;
  /** Why the fetch did not replace the cache, or `null` when it did. */
  error: string | null;
  /**
   * The default URL answered 404/410: our catalog is not published yet.
   * Not an error; the previous cache (usually none) stays.
   */
  notPublished?: boolean;
}

/**
 * Fetch the URL's catalog and, when it parses with at least one entry
 * (or is a valid empty list), write it to the cache. Any failure leaves
 * the previous cache in place and says why.
 */
export async function refreshExternalCatalog(input: {
  url: string;
  stateDir: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RefreshResult> {
  const cachePath = join(input.stateDir, EXTERNAL_CATALOG_CACHE_FILENAME);
  const previous = (): ExternalCatalog => readExternalCatalogFile(cachePath);
  const timeout = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let body: string;
  try {
    const res = await (input.fetchImpl ?? fetch)(input.url, {
      signal,
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (
      (res.status === 404 || res.status === 410) &&
      input.url === DEFAULT_EXTERNAL_CATALOG_URL
    ) {
      return { catalog: previous(), error: null, notPublished: true };
    }
    if (!res.ok) return { catalog: previous(), error: `the catalog URL answered ${res.status}` };
    body = await res.text();
  } catch (err) {
    return {
      catalog: previous(),
      error: `could not fetch the catalog: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (Buffer.byteLength(body) > MAX_CATALOG_BYTES) {
    return { catalog: previous(), error: `the catalog is larger than ${MAX_CATALOG_BYTES} bytes` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { catalog: previous(), error: "the catalog is not valid JSON" };
  }
  const catalog = parseExternalCatalog(raw, input.url);
  if (catalog.entries.length === 0 && catalog.rejected.length > 0) {
    return { catalog: previous(), error: catalog.rejected[0]! };
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, cachePath);
  return { catalog, error: null };
}

/** An entry's compatibility mark for this machine. */
export interface CatalogCompatibility {
  fit: QuantFit;
  /** Rough decode speed, labelled an estimate; `null` when not known. */
  speed: SpeedForecast | null;
  /** One short reason, e.g. "needs 16 GB of memory, this machine has 8". */
  why: string;
}

/**
 * The same fit the Hugging Face quant list shows, with one extra rule:
 * an entry that says it wants more GPU memory (`vramGb`) than the GPU has
 * is at best a tight fit, and one wanting more RAM than the machine has
 * (`minRamGb`) is too big, whatever its file size suggests.
 */
export function catalogCompatibility(
  def: LocalModelDef,
  machine: MachineForModels,
): CatalogCompatibility {
  let fit = quantFitFor(def.fileSizeGb, machine);
  const vram = def.vramGb;
  if (
    fit.tier === "fits" &&
    fit.placement === "gpu" &&
    vram !== undefined &&
    machine.gpuBudgetGb !== null &&
    vram > machine.gpuBudgetGb
  ) {
    fit = { tier: "tight", label: "Tight fit", placement: "ram" };
  }
  if (def.minRamGb > machine.ramGb) {
    fit = { tier: "too-big", label: "Too big", placement: "disk" };
  } else if (fit.tier === "fits" && def.recommendedRamGb > machine.ramGb) {
    fit = { tier: "tight", label: "Tight fit", placement: "ram" };
  }
  const speed = forecastDecodeSpeed({
    weightsGb: def.fileSizeGb,
    activeShare: activeShareFromName(`${def.name} ${def.filename}`),
    machine,
    fit,
  });
  const why =
    fit.tier === "too-big"
      ? `needs ${def.minRamGb} GB of memory, this machine has ${machine.ramGb}`
      : fit.tier === "tight"
        ? `wants ${def.recommendedRamGb} GB${vram !== undefined ? ` and ${vram} GB of GPU memory` : ""}; it will run slowly here`
        : `wants ${def.recommendedRamGb} GB, this machine has ${machine.ramGb}`;
  return { fit, speed, why };
}
