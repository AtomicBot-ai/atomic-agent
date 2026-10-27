import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract as tarExtract, pack as tarPack } from "tar-stream";

import { snapshotSqlite } from "../import/atomic-desktop/sqlite-snapshot.js";

/**
 * ATO-579 — the whole state dir (`~/.atomic-agent`, shared by the terminal
 * and the desktop) as one `.tar.gz`, and back.
 *
 * Into the archive: chats, memory, tasks, config.json, .env (API keys:
 * the archive is written owner-only and says so), skills, traces. Each
 * `*.sqlite` goes in as a snapshot taken through SQLite's backup API,
 * never as the live file. Left out: GGUF models (`models/`, re-downloadable
 * and tens of GB; `--with-models` keeps them), the browser profile (site
 * cookies), WAL/SHM side files, locks and runtime records.
 */
export const ARCHIVE_ROOT = "atomic-agent";
export const MANIFEST = "atomic-agent-backup.json";
const ALWAYS_SKIP = new Set(["browser-profile", "serve", "restore"]);
const SKIP_FILE = /(-wal|-shm|\.lock|\.pid)$/;

export interface BackupResult {
  file: string;
  files: number;
  bytes: number;
  skipped: string[];
}

function walk(root: string, dir: string, skipTop: Set<string>, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(root, abs);
    if (dir === root && skipTop.has(name)) continue;
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(root, abs, skipTop, out);
    else if (st.isFile() && !SKIP_FILE.test(name)) out.push(rel);
  }
}

export async function backupStateDir(
  stateDir: string,
  outFile: string,
  opts: { withModels?: boolean; appVersion?: string; now?: Date } = {},
): Promise<BackupResult> {
  const skipTop = new Set(ALWAYS_SKIP);
  if (!opts.withModels) skipTop.add("models");
  const out = resolve(outFile);
  if (out === stateDir || out.startsWith(stateDir + sep)) throw new Error("write the backup outside the data folder it backs up");
  const files: string[] = [];
  walk(stateDir, stateDir, skipTop, files);
  const scratch = mkdtempSync(join(tmpdir(), "atag-backup-"));
  const partial = `${out}.partial`;
  mkdirSync(dirname(out), { recursive: true });
  const pack = tarPack();
  const written = pipeline(pack, createGzip(), createWriteStream(partial, { mode: 0o600 }));
  let bytes = 0;
  try {
    const manifest = Buffer.from(JSON.stringify({
      kind: "atomic-agent-backup",
      version: 1,
      createdAt: (opts.now ?? new Date()).toISOString(),
      appVersion: opts.appVersion ?? null,
      withModels: !!opts.withModels,
      skipped: [...skipTop],
    }, null, 2));
    pack.entry({ name: `${ARCHIVE_ROOT}/${MANIFEST}`, mode: 0o600 }, manifest);
    for (const rel of files) {
      // Each file is copied first, so one a running agent appends to (a trace,
      // a log) cannot change size under the tar entry and abort the backup.
      const src = join(scratch, rel.split(sep).join("__"));
      if (rel.endsWith(".sqlite")) await snapshotSqlite(join(stateDir, rel), src);
      else copyFileSync(join(stateDir, rel), src);
      const st = statSync(src);
      const orig = statSync(join(stateDir, rel), { throwIfNoEntry: false });
      bytes += st.size;
      const entry = pack.entry({ name: `${ARCHIVE_ROOT}/${rel.split(sep).join("/")}`, size: st.size, mode: (orig?.mode ?? st.mode) & 0o777, mtime: orig?.mtime ?? st.mtime });
      await pipeline(createReadStream(src), entry);
      rmSync(src, { force: true });
    }
    pack.finalize();
    await written;
    renameSync(partial, out);
    chmodSync(out, 0o600);
  } catch (err) {
    pack.destroy();
    await written.catch(() => {});
    rmSync(partial, { force: true });
    throw err;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { file: out, files: files.length, bytes, skipped: [...skipTop] };
}

/** A tar entry name as a path under `root`, or null when it would land outside it. */
function safeTarget(root: string, name: string): string | null {
  const parts = name.split("/").filter((p) => p.length > 0);
  if (parts[0] !== ARCHIVE_ROOT || parts.some((p) => p === ".." || p.includes("\\")) || parts.length < 2) return null;
  const target = resolve(root, ...parts.slice(1));
  return target.startsWith(root + sep) ? target : null;
}

/** Unpack a backup into `intoDir` (created, must not exist). Returns its manifest. */
export async function unpackBackup(archive: string, intoDir: string): Promise<Record<string, unknown>> {
  mkdirSync(intoDir, { recursive: false, mode: 0o700 });
  const ex = tarExtract();
  ex.on("entry", (header, stream, next) => {
    const target = header.type === "file" ? safeTarget(intoDir, header.name) : null;
    if (!target) {
      stream.resume();
      stream.on("end", next);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    pipeline(stream, createWriteStream(target, { mode: (header.mode ?? 0o600) & 0o777 })).then(() => next(), next);
  });
  await pipeline(createReadStream(archive), createGunzip(), ex);
  const manifestPath = join(intoDir, MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`${archive} is not an Atomic Agent backup (no ${MANIFEST} inside)`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.kind !== "atomic-agent-backup") throw new Error(`${archive} is not an Atomic Agent backup`);
  rmSync(manifestPath);
  for (const secret of ["config.json", ".env"]) {
    if (existsSync(join(intoDir, secret))) chmodSync(join(intoDir, secret), 0o600);
  }
  return manifest;
}
