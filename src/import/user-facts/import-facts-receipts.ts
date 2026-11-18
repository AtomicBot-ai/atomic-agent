import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ImportFactsReceipt, ImportFactsSourceLabel } from "./save-fact-candidates.js";

/**
 * Receipts of facts imports, one JSON file each under
 * `<stateDir>/import-receipts/`. The profile table carries no tags, so a
 * receipt is the only way to undo the profile half of an import
 * (save-fact-candidates.ts). A receipt holds ids and keys, never fact text.
 *
 * Written atomically (temp file + rename). Ids are `facts-<savedAt>-<source>`,
 * so listing sorts newest first by name.
 */
export const IMPORT_RECEIPTS_DIR = "import-receipts";

export interface StoredImportFactsReceipt extends ImportFactsReceipt {
  id: string;
}

const ID_RE = /^facts-\d{1,16}-(?:claude|chatgpt)(?:-\d{1,3})?$/;

export function importReceiptsDir(stateDir: string): string {
  return join(stateDir, IMPORT_RECEIPTS_DIR);
}

export function isImportReceiptId(id: string): boolean {
  return ID_RE.test(id);
}

/** Persist a receipt and return its id. An import that wrote nothing has no receipt: `null`. */
export function writeImportReceipt(stateDir: string, receipt: ImportFactsReceipt): string | null {
  if (receipt.profile.length === 0 && receipt.noteIds.length === 0) return null;
  const dir = importReceiptsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const base = `facts-${receipt.savedAt}-${receipt.source}`;
  let id = base;
  const taken = new Set(safeList(dir));
  for (let n = 2; taken.has(`${id}.json`); n += 1) id = `${base}-${n}`;
  const file = join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ id, ...receipt }, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return id;
}

export function readImportReceipt(stateDir: string, id: string): StoredImportFactsReceipt | null {
  if (!isImportReceiptId(id)) return null;
  try {
    return parseReceipt(JSON.parse(readFileSync(join(importReceiptsDir(stateDir), `${id}.json`), "utf8")));
  } catch {
    return null;
  }
}

/** Newest first. Unreadable files are skipped. */
export function listImportReceipts(stateDir: string): StoredImportFactsReceipt[] {
  const out: StoredImportFactsReceipt[] = [];
  for (const name of safeList(importReceiptsDir(stateDir))) {
    if (!name.endsWith(".json")) continue;
    const r = readImportReceipt(stateDir, name.slice(0, -".json".length));
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function deleteImportReceipt(stateDir: string, id: string): void {
  if (!isImportReceiptId(id)) return;
  rmSync(join(importReceiptsDir(stateDir), `${id}.json`), { force: true });
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function parseReceipt(raw: unknown): StoredImportFactsReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const source = r.source;
  if (typeof r.id !== "string" || !isImportReceiptId(r.id)) return null;
  if (source !== "claude" && source !== "chatgpt") return null;
  if (typeof r.savedAt !== "number" || !Array.isArray(r.profile) || !Array.isArray(r.noteIds)) return null;
  const profile = r.profile.filter(
    (p): p is { key: string; id: number } =>
      !!p && typeof p === "object" && typeof (p as { key?: unknown }).key === "string"
      && typeof (p as { id?: unknown }).id === "number",
  );
  const noteIds = r.noteIds.filter((n): n is number => typeof n === "number");
  return { id: r.id, source: source as ImportFactsSourceLabel, savedAt: r.savedAt, profile, noteIds };
}
