/**
 * Models already on this computer (local-model-scan.ts), for the window:
 * `discoverLocalModels()` and the registration half of `useLocalModel(path)`.
 * main.ts wires both IPCs; the switch itself is main's own `switched(() =>
 * selectLocalModel(id))`, the call a finished starter download makes.
 *
 * The scan is cached for a short while (the onboarding screen and Settings
 * may both ask within seconds), and one scan runs at a time. Registration
 * accepts only a path the last scan returned (rememberDiscovered, the
 * plugins-ipc wasPickedFolder pattern): the window never names a file of its
 * own making.
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { addCustomModelEntry, managedDataDirNow, remoteModelsActive } from "./agent-cli.js";
import { modelsDirOf } from "./disk-space.js";
import { buildLocalGgufModelDef, resolveLocalGgufFile } from "./local-gguf.js";
import {
  discoveredModel,
  publicModels,
  rememberDiscovered,
  scanLocalModels,
  scanRoots,
  type FoundModel,
  type FoundModelMeta,
  type Registry,
} from "./local-model-scan.js";
import { curatedMeta } from "./model-catalog.js";
import { DESKTOP_STATE_DIR, TUI_STATE_DIR } from "./state-dir.js";

const CACHE_MS = 30_000;

let cached: { at: number; models: FoundModelMeta[] } | null = null;
let running: Promise<FoundModelMeta[]> | null = null;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type LocalModelsBlock = { customModels?: unknown; managed?: { dataDirOverride?: unknown } };

/** `<stateDir>/config.json`'s `localModels`, or an empty block. */
function localModelsOf(stateDir: string): LocalModelsBlock {
  const cfg = readJson(join(stateDir, "config.json"));
  const lm = cfg?.["localModels"];
  return lm && typeof lm === "object" ? (lm as LocalModelsBlock) : {};
}

/** The default `~/.atomic-agent` store, when the app runs on another state dir (managedDataDir's rule, for that dir). */
function defaultStoreDir(): string | null {
  if (DESKTOP_STATE_DIR === TUI_STATE_DIR) return null;
  const override = localModelsOf(TUI_STATE_DIR).managed?.dataDirOverride;
  const raw = typeof override === "string" ? override.trim() : "";
  const dataDir = !raw ? join(TUI_STATE_DIR, "models")
    : raw.startsWith("~") ? resolvePath(homedir(), raw.slice(2))
      : resolvePath(raw);
  return modelsDirOf(dataDir);
}

/** LM Studio keeps the path of a moved home folder in `~/.lmstudio-home-pointer`. */
async function lmStudioHome(): Promise<string | null> {
  try {
    const text = (await readFile(join(homedir(), ".lmstudio-home-pointer"), "utf8")).trim();
    return text && isAbsolute(text) ? text : null;
  } catch {
    return null;
  }
}

function registryNow(managedModelsDir: string): Registry {
  const custom = localModelsOf(DESKTOP_STATE_DIR).customModels;
  return {
    managedModelsDir,
    customModels: Array.isArray(custom) ? (custom as Registry["customModels"]) : [],
    isCatalogId: (id) => curatedMeta(id) !== null,
    catalogName: (id) => curatedMeta(id)?.name ?? null,
  };
}

async function scanNow(): Promise<FoundModelMeta[]> {
  const managedModelsDir = modelsDirOf(managedDataDirNow());
  const roots = scanRoots({
    home: homedir(),
    platform: process.platform,
    env: process.env,
    managedModelsDir,
    defaultModelsDir: defaultStoreDir(),
    lmStudioHome: await lmStudioHome(),
  });
  const { models } = await scanLocalModels(roots, registryNow(managedModelsDir));
  return models;
}

/** `cli:discoverLocalModels`. Empty while the app runs chats on another computer: its models live there. */
export async function discoverLocalModels(opts?: { fresh?: boolean }): Promise<{ models: FoundModel[] }> {
  if (remoteModelsActive()) {
    rememberDiscovered([]);
    return { models: [] };
  }
  if (!opts?.fresh && cached && Date.now() - cached.at < CACHE_MS) return { models: publicModels(cached.models) };
  if (!running) {
    running = scanNow()
      .then((models) => {
        cached = { at: Date.now(), models };
        rememberDiscovered(models);
        return models;
      })
      .catch(() => [] as FoundModelMeta[])
      .finally(() => { running = null; });
  }
  return { models: publicModels(await running) };
}

/** A registration changed what is registered: the next ask scans again. */
export function forgetDiscovery(): void {
  cached = null;
}

/**
 * The registration half of `cli:useLocalModel`: the model id the file runs
 * as, adding a `localPath` entry when the app does not know it yet. An orphan
 * inside the store (its entry lost) is registered in place too; the managed
 * store guard (MANAGED_GGUF_PATH_ERROR) is for a path typed into a dialog.
 * `inPlace` forces the entry even for a file the scan took for registered
 * (a catalogue folder holding a file the catalogue no longer names).
 */
export async function registerDiscoveredModel(
  path: unknown,
  opts?: { inPlace?: boolean },
): Promise<{ ok: true; id: string; added: boolean; wasRegistered: boolean } | { ok: false; error: string }> {
  if (remoteModelsActive()) return { ok: false, error: "This app is connected to an agent on another computer: its models are managed there." };
  const hit = discoveredModel(path);
  if (!hit) return { ok: false, error: "That file was not in the list of models found on this computer. Look again and pick it from the list." };
  if (hit.registered && hit.modelId && !opts?.inPlace) return { ok: true, id: hit.modelId, added: false, wasRegistered: true };
  let def: ReturnType<typeof buildLocalGgufModelDef>;
  try {
    const managed = modelsDirOf(managedDataDirNow());
    def = buildLocalGgufModelDef(
      resolveLocalGgufFile(hit.path, hit.orphanInStore || opts?.inPlace ? undefined : { managedModelsDir: managed }),
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // The scan's name reads better than the file name ("Qwen3-8B-Q4_K_M (local file)").
  def.name = `${hit.name} (local file)`;
  const res = await addCustomModelEntry(def as unknown as Record<string, unknown>);
  if (!res.ok) return { ok: false, error: res.error ?? (res.stderr || "could not write the config") };
  forgetDiscovery();
  return { ok: true, id: def.id, added: true, wasRegistered: hit.registered };
}
