/**
 * ATO-2448: `atag launch <agent> --config` writes a lasting setup into the
 * CLI's own config file, so plain `claude` / `codex` / `opencode` use this
 * machine's model afterwards; `--revert` takes it out again. As in
 * `ollama launch --config`.
 *
 * Before the first write the file is copied to `<file>.atomic-agent-backup`
 * (kept, never overwritten). What each edit replaced is recorded in
 * `<stateDir>/launch-config/<agent>.json`; `--revert` restores exactly
 * that, keeps any key the person changed since, and deletes the record.
 * Running `--config` again replaces the earlier setup instead of stacking.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { applyJsonEdits, parseSettings, revertJsonEdits, serializeSettings, type JsonUndo } from "./launch-config-json.js";
import type { PersistSpec } from "./launch-config-targets.js";
import { hasForeignAtomicProvider, withOurEdits, withoutOurEdits } from "./launch-config-toml.js";

export const BACKUP_SUFFIX = ".atomic-agent-backup";

interface ConfigRecord {
  readonly version: 1;
  readonly file: string;
  readonly kind: PersistSpec["kind"];
  /** JSON files only. */
  readonly undo?: readonly JsonUndo[];
  /** Whether the file existed before the first write. */
  readonly existed: boolean;
}

export interface LaunchConfigFs {
  readonly read: (path: string) => string | null;
  readonly write: (path: string, text: string) => void;
  readonly exists: (path: string) => boolean;
  readonly copy: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export const nodeConfigFs: LaunchConfigFs = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  },
  exists: existsSync,
  copy: copyFileSync,
  remove: (path) => rmSync(path, { force: true }),
};

export function configRecordPath(stateDir: string, id: string): string {
  return join(stateDir, "launch-config", `${id}.json`);
}

function readRecord(fs: LaunchConfigFs, path: string): ConfigRecord | null {
  const text = fs.read(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as ConfigRecord;
    return parsed && parsed.version === 1 && typeof parsed.file === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export type ConfigResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly error: string };

/** Write the setting; an earlier one of ours is reverted first. */
export function applyLaunchConfig(stateDir: string, id: string, spec: PersistSpec, fs: LaunchConfigFs = nodeConfigFs): ConfigResult {
  const recordPath = configRecordPath(stateDir, id);
  const earlier = readRecord(fs, recordPath);
  if (earlier) {
    const undone = revertLaunchConfig(stateDir, id, fs);
    if (!undone.ok) return undone;
  }
  const before = fs.read(spec.file);
  const existed = before !== null;
  const backup = `${spec.file}${BACKUP_SUFFIX}`;
  let next: string;
  let undo: JsonUndo[] | undefined;
  if (spec.kind === "json") {
    const parsed = parseSettings(before);
    if ("error" in parsed) {
      return { ok: false, error: `${spec.file} was left as it is: ${parsed.error}. Fix it, or set it up by hand (see atag launch ${id} --print-env).` };
    }
    const applied = applyJsonEdits(parsed, spec.edits);
    next = serializeSettings(applied.root);
    undo = applied.undo;
  } else {
    if (before !== null && hasForeignAtomicProvider(before)) {
      return { ok: false, error: `${spec.file} already has its own [model_providers.atomic]; rename or remove it, then run this again.` };
    }
    next = withOurEdits(before ?? "", spec.settings);
  }
  if (existed && !fs.exists(backup)) fs.copy(spec.file, backup);
  const record: ConfigRecord = { version: 1, file: spec.file, kind: spec.kind, existed, ...(undo ? { undo } : {}) };
  fs.write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.write(spec.file, next);
  const lines = [`Wrote ${spec.file}${existed ? ` (a copy of the old one is in ${backup})` : ""}.`];
  if (spec.note) lines.push(spec.note.trimEnd());
  lines.push(`To undo: atag launch ${id} --revert`);
  return { ok: true, lines };
}

/** Take our setting out of the CLI's file. */
export function revertLaunchConfig(stateDir: string, id: string, fs: LaunchConfigFs = nodeConfigFs): ConfigResult {
  const recordPath = configRecordPath(stateDir, id);
  const record = readRecord(fs, recordPath);
  if (!record) return { ok: true, lines: [`Nothing to undo: atag launch ${id} --config has not written a setting here.`] };
  const now = fs.read(record.file);
  const lines: string[] = [];
  if (now === null) {
    lines.push(`${record.file} is gone; nothing to undo there.`);
  } else if (record.kind === "json") {
    const parsed = parseSettings(now);
    if ("error" in parsed) return { ok: false, error: `${record.file} was left as it is: ${parsed.error}. Fix it, then run this again.` };
    const reverted = revertJsonEdits(parsed, record.undo ?? []);
    const emptyAndNew = !record.existed && Object.keys(reverted.root).length === 0;
    if (emptyAndNew) fs.remove(record.file);
    else fs.write(record.file, serializeSettings(reverted.root));
    lines.push(emptyAndNew ? `Removed ${record.file} (launch had created it).` : `Restored the settings in ${record.file}.`);
    if (reverted.kept.length > 0) lines.push(`Kept, because they were changed after launch wrote them: ${reverted.kept.join(", ")}.`);
  } else {
    const clean = withoutOurEdits(now);
    if (!record.existed && clean.trim() === "") fs.remove(record.file);
    else fs.write(record.file, clean);
    lines.push(`Removed the Atomic Agent provider from ${record.file}.`);
  }
  fs.remove(recordPath);
  return { ok: true, lines };
}
