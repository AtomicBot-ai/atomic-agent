import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract as tarExtract } from "tar-stream";

import {
  BUNDLE_ROOT,
  MANIFEST_NAME,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_MEMORY_BYTES,
  MAX_TOTAL_BYTES,
  MEMORY_NAME,
  isAllowedBundlePath,
  manifestProblem,
  type SetupManifest,
} from "./setup-bundle-format.js";

/**
 * ATO-1073: unpack a setup bundle into a private staging folder, refusing
 * the whole bundle at the first entry that is not what a bundle may hold.
 * The bundle came from someone else, so nothing in it is trusted:
 *  - the manifest must come first and be a valid `atomic-agent-setup`;
 *  - every other entry must be a regular file listed in it, under
 *    `atomic-agent-setup/`, at an allow-listed path (no absolute path,
 *    no `..`, no backslash; setup-bundle-format.ts isAllowedBundlePath);
 *  - links and devices are refused, not skipped;
 *  - per-file, total and entry-count caps hold while bytes stream, so a
 *    crafted archive cannot fill the disk.
 */
export class SetupBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupBundleError";
  }
}

function capped(limit: number, onOver: () => Error, account: (n: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      account(chunk.length);
      if (seen > limit) done(onOver());
      else done(null, chunk);
    },
  });
}

/** Unpack `archive` into `intoDir` (created; must not exist). Returns the validated manifest. */
export async function readSetupBundle(archive: string, intoDir: string): Promise<SetupManifest> {
  const root = resolve(intoDir);
  mkdirSync(root, { recursive: false, mode: 0o700 });
  // A holder, not a `let`: it is set inside the entry callback.
  const state: { manifest: SetupManifest | null } = { manifest: null };
  let listed = new Set<string>();
  let total = 0;
  let entries = 0;
  const seen = new Set<string>();
  const ex = tarExtract();

  ex.on("entry", (header, stream, next) => {
    const fail = (message: string) => {
      stream.resume();
      next(new SetupBundleError(message));
    };
    entries += 1;
    if (entries > MAX_ENTRIES) return fail(`bundle has more than ${MAX_ENTRIES} entries`);
    if (header.type === "directory") {
      stream.resume();
      stream.on("end", () => next());
      return;
    }
    if (header.type !== "file") return fail(`bundle holds a ${header.type} entry (${header.name}); only plain files are allowed`);
    const prefix = `${BUNDLE_ROOT}/`;
    if (!header.name.startsWith(prefix)) return fail(`entry outside ${prefix}: ${header.name}`);
    const rel = header.name.slice(prefix.length);
    if (!isAllowedBundlePath(rel)) return fail(`entry at a path a setup may not write: ${header.name}`);
    if (seen.has(rel)) return fail(`entry appears twice: ${rel}`);
    seen.add(rel);

    if (state.manifest === null) {
      if (rel !== MANIFEST_NAME) return fail(`the first entry must be ${MANIFEST_NAME}`);
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= 1024 * 1024) chunks.push(c);
      });
      stream.on("error", next);
      stream.on("end", () => {
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          next(new SetupBundleError(`${MANIFEST_NAME} is not valid JSON`));
          return;
        }
        const problem = size > 1024 * 1024 ? `${MANIFEST_NAME} is too large` : manifestProblem(raw);
        if (problem) {
          next(new SetupBundleError(problem));
          return;
        }
        const parsed = raw as SetupManifest;
        state.manifest = parsed;
        listed = new Set(parsed.files.map((f) => f.path));
        next();
      });
      return;
    }
    if (rel === MANIFEST_NAME || !listed.has(rel)) return fail(`entry not listed in the manifest: ${rel}`);
    const target = resolve(root, ...rel.split("/"));
    if (!target.startsWith(root + sep)) return fail(`entry escapes the bundle: ${rel}`);
    const limit = rel === MEMORY_NAME ? MAX_MEMORY_BYTES : MAX_FILE_BYTES;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    pipeline(
      stream,
      capped(limit, () => new SetupBundleError(`${rel} is larger than ${limit} bytes`), (n) => {
        total += n;
      }),
      createWriteStream(target, { mode: 0o600 }),
    ).then(
      () => (total > MAX_TOTAL_BYTES ? next(new SetupBundleError(`bundle unpacks to more than ${MAX_TOTAL_BYTES} bytes`)) : next()),
      (err: unknown) => next(err instanceof Error ? err : new Error(String(err))),
    );
  });

  try {
    await pipeline(createReadStream(archive), createGunzip(), ex);
  } catch (err) {
    if (err instanceof SetupBundleError) throw err;
    throw new SetupBundleError(`cannot read ${archive} as a setup bundle: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (state.manifest === null) throw new SetupBundleError(`${archive} has no ${MANIFEST_NAME}`);
  return state.manifest;
}

/** Where a bundle-relative path lives in the staging folder. */
export function stagedPath(stagingDir: string, rel: string): string {
  return join(stagingDir, ...rel.split("/"));
}
