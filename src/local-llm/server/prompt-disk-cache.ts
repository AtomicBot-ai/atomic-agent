/**
 * The chat daemon's prompt cache on disk between runs (ATO-456), off by
 * default (`localModels.managed.promptDiskCache`).
 *
 * With `--slot-save-path` llama-server writes a slot's KV cache to a file
 * and loads it back (`POST /slots/{id}?action=save|restore`). A managed
 * stop saves every idle slot; the next start loads the newest saves into
 * the low slots, and a resumed session's first request (`id_slot: -1`,
 * `cache_prompt: true`, `slot-manager.ts`) lands on its prompt by
 * llama.cpp's prefix-similarity pick. Atomic Core has no slot route of
 * its own: the flag reaches its llama-server through the launch's extra
 * arguments (`coreLoadOverrides`), and the agent talks to that server.
 *
 * A state file from another model, window, cache type, flash-attention
 * mode or slot layout loads garbage rather than failing, so each file
 * has a fingerprint beside it and a mismatch is deleted, never loaded.
 * Saves under {@link PROMPT_CACHE_MIN_TOKENS} are dropped; the folder is
 * held to {@link PROMPT_CACHE_MAX_BYTES}, oldest first. Best effort: a
 * failed save or restore costs the speed-up, never the start or stop.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePromptCacheDir } from "../backend-paths.js";

/** Shorter prompts are cheap to read again; their files are not kept. */
export const PROMPT_CACHE_MIN_TOKENS = 256;

/** Most disk the saved caches may take together: 8 GiB. */
export const PROMPT_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** Per-slot bound on a save or restore request (a long cache is hundreds of MB). */
export const PROMPT_CACHE_SLOT_TIMEOUT_MS = 20_000;

/** Bound on saving every slot before a stop. */
export const PROMPT_CACHE_SAVE_BUDGET_MS = 45_000;

const STATE_SUFFIX = ".bin";
const FINGERPRINT_SUFFIX = ".json";

/** The launch flags a saved cache depends on, besides the model and engine. */
const FINGERPRINT_FLAGS = [
  "-m",
  "--ctx-size",
  "--cache-type-k",
  "--cache-type-v",
  "--flash-attn",
  "--parallel",
  "--mmproj",
  "--device",
  "--split-mode",
  "--tensor-split",
] as const;
const FINGERPRINT_SWITCHES = ["--swa-full", "-kvu"] as const;

/**
 * A fingerprint of the launch: model file (path, size, modification
 * time), the engine build, and the flags that shape the KV cache. Pure
 * given the model file's stat.
 */
export function promptCacheFingerprint(input: {
  args: readonly string[];
  engineBuild: string;
  modelFile?: { size: number; mtimeMs: number } | null;
}): string {
  const flags: Record<string, string | boolean> = {};
  for (const flag of FINGERPRINT_FLAGS) {
    const at = input.args.indexOf(flag);
    if (at >= 0 && at + 1 < input.args.length) flags[flag] = input.args[at + 1]!;
  }
  for (const flag of FINGERPRINT_SWITCHES) flags[flag] = input.args.includes(flag);
  const material = JSON.stringify({
    engineBuild: input.engineBuild,
    model: input.modelFile ? { size: input.modelFile.size, mtimeMs: Math.floor(input.modelFile.mtimeMs) } : null,
    flags,
  });
  return createHash("sha256").update(material).digest("hex");
}

/** The model file's stat for the fingerprint, `null` when unreadable. */
export function statModelFile(modelPath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(modelPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** The `--slot-save-path` flag for a launch with the cache on; creates the folder. */
export function promptCacheLaunchArgs(dataDir: string): string[] {
  const dir = resolvePromptCacheDir(dataDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return [];
  }
  return ["--slot-save-path", dir];
}

interface SavedFingerprint {
  fingerprint: string;
  tokens: number;
  savedAt: number;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Every file of one save: the state, llama.cpp's checkpoint sidecar, our fingerprint. */
function removeSave(dir: string, stateName: string): void {
  removeQuietly(join(dir, stateName));
  removeQuietly(join(dir, `${stateName}.ckpt`));
  removeQuietly(join(dir, `${stateName}${FINGERPRINT_SUFFIX}`));
}

function readSaved(dir: string, stateName: string): SavedFingerprint | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${stateName}${FINGERPRINT_SUFFIX}`), "utf8")) as Partial<SavedFingerprint>;
    if (typeof parsed.fingerprint !== "string") return null;
    return {
      fingerprint: parsed.fingerprint,
      tokens: typeof parsed.tokens === "number" ? parsed.tokens : 0,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

function listStateNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(STATE_SUFFIX));
  } catch {
    return [];
  }
}

function saveBytes(dir: string, stateName: string): number {
  let total = 0;
  for (const name of [stateName, `${stateName}.ckpt`, `${stateName}${FINGERPRINT_SUFFIX}`]) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      /* absent */
    }
  }
  return total;
}

/**
 * Hold the folder to `maxBytes`: a state file with no fingerprint (a
 * save cut short) goes first, then the oldest saves until the rest fit.
 */
export function evictPromptCache(dataDir: string, maxBytes = PROMPT_CACHE_MAX_BYTES): void {
  const dir = resolvePromptCacheDir(dataDir);
  const saves: { name: string; savedAt: number; bytes: number }[] = [];
  for (const name of listStateNames(dir)) {
    const saved = readSaved(dir, name);
    if (!saved) {
      removeSave(dir, name);
      continue;
    }
    saves.push({ name, savedAt: saved.savedAt, bytes: saveBytes(dir, name) });
  }
  saves.sort((a, b) => b.savedAt - a.savedAt);
  let total = 0;
  for (const save of saves) {
    total += save.bytes;
    if (total > maxBytes) removeSave(dir, save.name);
  }
}

type FetchLike = typeof fetch;

async function postSlotAction(opts: {
  port: number;
  apiKey: string | null;
  slotId: number;
  action: "save" | "restore";
  filename: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await (opts.fetchImpl ?? fetch)(
      `http://127.0.0.1:${opts.port}/slots/${opts.slotId}?action=${opts.action}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ filename: opts.filename }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? PROMPT_CACHE_SLOT_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The ids of the server's idle slots, `[]` when `/slots` does not answer. */
async function idleSlotIds(port: number, apiKey: string | null, fetchImpl?: FetchLike): Promise<number[]> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await (fetchImpl ?? fetch)(`http://127.0.0.1:${port}/slots`, {
      headers,
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return [];
    const slots = (await res.json()) as unknown;
    if (!Array.isArray(slots)) return [];
    return slots
      .filter((s): s is { id: number; is_processing?: unknown } =>
        typeof s === "object" && s !== null && Number.isInteger((s as { id?: unknown }).id))
      .filter((s) => s.is_processing !== true)
      .map((s) => s.id);
  } catch {
    return [];
  }
}

/**
 * Save the cache of every idle slot of the server on `port` before it
 * stops. Returns how many saves were kept (at least
 * {@link PROMPT_CACHE_MIN_TOKENS} tokens each).
 */
export async function savePromptCaches(opts: {
  dataDir: string;
  port: number;
  apiKey: string | null;
  fingerprint: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  budgetMs?: number;
}): Promise<number> {
  const dir = resolvePromptCacheDir(opts.dataDir);
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? PROMPT_CACHE_SAVE_BUDGET_MS);
  const stamp = now();
  let kept = 0;
  for (const slotId of await idleSlotIds(opts.port, opts.apiKey, opts.fetchImpl)) {
    const left = deadline - now();
    if (left <= 0) break;
    const filename = `slot-${stamp}-${slotId}${STATE_SUFFIX}`;
    const res = await postSlotAction({
      port: opts.port,
      apiKey: opts.apiKey,
      slotId,
      action: "save",
      filename,
      timeoutMs: Math.min(PROMPT_CACHE_SLOT_TIMEOUT_MS, left),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const tokens = typeof res?.n_saved === "number" ? res.n_saved : 0;
    if (!res || tokens < PROMPT_CACHE_MIN_TOKENS) {
      removeSave(dir, filename);
      continue;
    }
    try {
      const saved: SavedFingerprint = { fingerprint: opts.fingerprint, tokens, savedAt: now() };
      writeFileSync(join(dir, `${filename}${FINGERPRINT_SUFFIX}`), JSON.stringify(saved), { mode: 0o600 });
      kept += 1;
    } catch {
      removeSave(dir, filename);
    }
  }
  evictPromptCache(opts.dataDir);
  return kept;
}

/**
 * Load the newest matching saves back into slots `0 … n − 1` after a
 * start, where `n` leaves the highest slot to the reflection side calls
 * (`SlotManager.reserveReflectionSlot`) when the launch has more than
 * one. A save from another launch is deleted unread; a save that was
 * loaded, or that the server refused, is deleted too (the next stop
 * saves the slot again); older saves stay within the size cap. Returns
 * how many slots were restored.
 */
export async function restorePromptCaches(opts: {
  dataDir: string;
  port: number;
  apiKey: string | null;
  fingerprint: string;
  slots: number;
  fetchImpl?: FetchLike;
}): Promise<number> {
  const dir = resolvePromptCacheDir(opts.dataDir);
  const matching: { name: string; savedAt: number }[] = [];
  for (const name of listStateNames(dir)) {
    const saved = readSaved(dir, name);
    if (!saved || saved.fingerprint !== opts.fingerprint || saved.tokens < PROMPT_CACHE_MIN_TOKENS) {
      removeSave(dir, name);
      continue;
    }
    matching.push({ name, savedAt: saved.savedAt });
  }
  matching.sort((a, b) => b.savedAt - a.savedAt);
  const slots = Math.max(1, Math.floor(opts.slots));
  const targets = slots > 1 ? slots - 1 : 1;
  let restored = 0;
  for (const [slotId, save] of matching.slice(0, targets).entries()) {
    const res = await postSlotAction({
      port: opts.port,
      apiKey: opts.apiKey,
      slotId,
      action: "restore",
      filename: save.name,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (res) restored += 1;
    // Loaded or refused: the server has it now or never will, and the
    // next stop saves the slot afresh. Older saves stay, within the cap.
    removeSave(dir, save.name);
  }
  return restored;
}
