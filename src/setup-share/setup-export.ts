import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";

import { snapshotSqlite } from "../import/atomic-desktop/sqlite-snapshot.js";
import { collectSetup } from "./collect-setup.js";
import {
  BUNDLE_FORMAT,
  BUNDLE_ROOT,
  BUNDLE_VERSION,
  CONFIG_NAME,
  MANIFEST_NAME,
  MAX_MEMORY_BYTES,
  MEMORY_NAME,
  type SetupManifest,
} from "./setup-bundle-format.js";

/**
 * ATO-1073 — `atag setup export`: the agent setup as one `.tar.gz` a
 * person can hand to someone else (Hermes' `profile export`). The
 * manifest goes in first and lists every file, so the recipient (and
 * `setup import --dry-run`) sees what is inside before anything lands.
 * Memory is personal and stays out unless `includeMemory` is set; it then
 * goes in as a snapshot taken through SQLite's backup API.
 */
export interface ExportSetupInput {
  stateDir: string;
  outFile: string;
  starterSkills: ReadonlySet<string>;
  includeMemory?: boolean;
  appVersion?: string;
  now?: Date;
}

export interface ExportSetupResult {
  file: string;
  manifest: SetupManifest;
}

export async function exportSetup(input: ExportSetupInput): Promise<ExportSetupResult> {
  const stateDir = resolve(input.stateDir);
  const out = resolve(input.outFile);
  if (out === stateDir || out.startsWith(stateDir + sep)) {
    throw new Error("write the bundle outside the data folder it is made from");
  }
  const collected = collectSetup({ stateDir, starterSkills: input.starterSkills });
  const configBytes = Buffer.from(`${JSON.stringify(collected.share.config, null, 2)}\n`);
  const scratch = mkdtempSync(join(tmpdir(), "atag-setup-export-"));
  const partial = `${out}.partial`;
  try {
    let memory: { abs: string; size: number } | null = null;
    const leftOut = [...collected.leftOut];
    const memoryDb = join(stateDir, MEMORY_NAME);
    if (input.includeMemory && existsSync(memoryDb)) {
      const snap = join(scratch, MEMORY_NAME);
      await snapshotSqlite(memoryDb, snap);
      const size = statSync(snap).size;
      if (size > MAX_MEMORY_BYTES) leftOut.push(`${MEMORY_NAME} (over ${MAX_MEMORY_BYTES / 1024 / 1024} MB)`);
      else memory = { abs: snap, size };
    }
    const manifest: SetupManifest = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      createdAt: (input.now ?? new Date()).toISOString(),
      appVersion: input.appVersion ?? null,
      contents: {
        skills: collected.skills,
        agents: collected.agents,
        mcpServers: collected.share.mcpServers,
        providers: collected.share.providers,
        personas: collected.share.personas,
        memory: memory !== null,
      },
      redacted: collected.share.redacted,
      leftOut,
      files: [
        { path: CONFIG_NAME, size: configBytes.length },
        ...collected.files.map((f) => ({ path: f.path, size: f.size })),
        ...(memory ? [{ path: MEMORY_NAME, size: memory.size }] : []),
      ],
    };
    mkdirSync(dirname(out), { recursive: true });
    const pack = tarPack();
    const written = pipeline(pack, createGzip(), createWriteStream(partial, { mode: 0o600 }));
    try {
      pack.entry({ name: `${BUNDLE_ROOT}/${MANIFEST_NAME}`, mode: 0o644 }, `${JSON.stringify(manifest, null, 2)}\n`);
      pack.entry({ name: `${BUNDLE_ROOT}/${CONFIG_NAME}`, mode: 0o644 }, configBytes);
      const sources = [...collected.files, ...(memory ? [{ path: MEMORY_NAME, ...memory }] : [])];
      for (const file of sources) {
        // The size is taken again at write time: a skill edited since the
        // walk would otherwise abort the tar entry half way.
        const size = statSync(file.abs).size;
        if (size === 0) {
          pack.entry({ name: `${BUNDLE_ROOT}/${file.path}`, mode: 0o644 }, "");
          continue;
        }
        const entry = pack.entry({ name: `${BUNDLE_ROOT}/${file.path}`, size, mode: 0o644 });
        await pipeline(createReadStream(file.abs, { start: 0, end: size - 1 }), entry);
      }
      pack.finalize();
      await written;
    } catch (err) {
      pack.destroy();
      await written.catch(() => {});
      throw err;
    }
    renameSync(partial, out);
    return { file: out, manifest };
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
