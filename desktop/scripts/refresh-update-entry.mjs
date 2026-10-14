/**
 * Rewrite one file's `size` and `sha512` in an electron-builder update file
 * (`stable-mac.yml`) after the file was changed on disk (ATO-369).
 *
 * The desktop workflow notarizes and staples the DMG after electron-builder
 * wrote `stable-mac.yml`. Stapling rewrites the DMG, so its `files[]` entry
 * kept the pre-staple size and sha512. The mac zip (the `path` electron-updater
 * downloads) is not touched after the yml is written and stays correct.
 *
 * `sha512` is the base64 SHA-512 of the file, the format electron-updater
 * checks. When the top-level legacy `path` names the same file, its `sha512`
 * is updated too.
 *
 * Usage (desktop/):
 *   node scripts/refresh-update-entry.mjs <update yml> <file>
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-updater"))("js-yaml");

/** The parsed update file in, the same object with `name`'s entry refreshed out. */
export function refreshUpdateEntry(info, name, { size, sha512 }) {
  const entry = Array.isArray(info?.files) ? info.files.find((f) => f?.url === name) : undefined;
  if (!entry) throw new Error(`${name} is not in files[]`);
  entry.size = size;
  entry.sha512 = sha512;
  if (info.path === name) info.sha512 = sha512;
  // A yml timestamp left unquoted comes back as a Date; keep it a string.
  if (info.releaseDate instanceof Date) info.releaseDate = info.releaseDate.toISOString();
  return info;
}

export function fileDigest(buf) {
  return { size: buf.length, sha512: createHash("sha512").update(buf).digest("base64") };
}

function main(argv) {
  if (argv.length !== 2) {
    console.error("usage: node scripts/refresh-update-entry.mjs <update yml> <file>");
    return 2;
  }
  const [ymlPath, filePath] = argv.map((p) => resolve(p));
  const info = refreshUpdateEntry(yaml.load(readFileSync(ymlPath, "utf8")), basename(filePath), fileDigest(readFileSync(filePath)));
  const out = yaml.dump(info, { lineWidth: -1, noRefs: true });
  writeFileSync(ymlPath, out);
  console.log(`refreshed ${basename(filePath)} in ${ymlPath}`);
  console.log(out);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`refresh-update-entry: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
