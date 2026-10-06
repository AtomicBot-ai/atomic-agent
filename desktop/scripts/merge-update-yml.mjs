/**
 * Merge the Windows update files of the x64 and the arm64 build into the one
 * `stable.yml` the feed serves (ATO-252).
 *
 * electron-updater on Windows reads ONE `<channel>.yml` whatever the arch and
 * installs the `.exe` in its `files` whose name contains its own
 * `process.arch` (`Atomic-Agent-Setup-<version>-x64.exe` or `...-arm64.exe`),
 * falling back to the first `.exe` listed. Each Windows job of the desktop
 * workflow writes its own `stable.yml` naming only its own installer, so
 * uploading both would keep whichever went up last. With only the arm64 file
 * left, an x64 app finds no x64 match and installs the arm64 installer.
 *
 * The merged file lists both installers. The top-level `path` / `sha512` are
 * the legacy single-file fields old updaters read; they stay on x64, the build
 * every existing Windows install has. `releaseDate` is the later of the two.
 *
 * Usage (desktop/):
 *   node scripts/merge-update-yml.mjs <x64 stable.yml> <arm64 stable.yml> <out stable.yml>
 *
 * The yml is read and written with the js-yaml electron-updater itself parses
 * it with (resolved through electron-updater, which depends on it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-updater"))("js-yaml");

/** A yml timestamp left unquoted comes back as a Date; the feed keeps strings. */
function isoDate(value) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? undefined : String(value);
}

function laterDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

function filesOf(info, label) {
  if (!info || typeof info !== "object") throw new Error(`${label}: not an update file`);
  if (!Array.isArray(info.files) || info.files.length === 0) {
    throw new Error(`${label}: no files[] (is this an electron-builder update file?)`);
  }
  for (const f of info.files) {
    if (!f || typeof f.url !== "string" || typeof f.sha512 !== "string") {
      throw new Error(`${label}: a files[] entry has no url or sha512`);
    }
  }
  return info.files;
}

/**
 * The two parsed update files in, the merged one out. Throws when they are
 * not one release of the two Windows arches (different versions, swapped
 * arguments, one file name with two different hashes).
 */
export function mergeUpdateInfo(x64, arm64) {
  const x64Files = filesOf(x64, "x64");
  const armFiles = filesOf(arm64, "arm64");
  if (String(x64.version) !== String(arm64.version)) {
    throw new Error(`versions differ: x64 ${x64.version}, arm64 ${arm64.version}`);
  }
  /* The arch in the installer name is what the updater matches on. Guard the
     argument order: swapped, the legacy `path` would point old updaters at
     the arm64 installer. */
  if (!x64Files.some((f) => f.url.includes("x64"))) {
    throw new Error("the first file lists no x64 installer; arguments are <x64> <arm64> <out>");
  }
  if (!armFiles.some((f) => f.url.includes("arm64"))) {
    throw new Error("the second file lists no arm64 installer; arguments are <x64> <arm64> <out>");
  }

  const files = [];
  const byUrl = new Map();
  for (const f of [...x64Files, ...armFiles]) {
    const seen = byUrl.get(f.url);
    if (seen) {
      if (seen.sha512 !== f.sha512) throw new Error(`${f.url} is listed twice with different sha512`);
      continue;
    }
    byUrl.set(f.url, f);
    files.push(f);
  }

  // x64 first so its keys (releaseNotes...) win; arm64 only fills gaps, never
  // the legacy path/sha512, which must not name the arm64 installer.
  const legacy = new Set(["path", "sha512"]);
  const merged = {
    version: x64.version,
    files,
    path: x64.path,
    sha512: x64.sha512,
    releaseDate: laterDate(isoDate(x64.releaseDate), isoDate(arm64.releaseDate)),
  };
  for (const [key, value] of [...Object.entries(x64), ...Object.entries(arm64)]) {
    if (legacy.has(key)) continue;
    if (!(key in merged) || merged[key] === undefined) merged[key] = value;
  }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

export function mergeUpdateYml(x64Text, arm64Text) {
  const merged = mergeUpdateInfo(yaml.load(x64Text), yaml.load(arm64Text));
  return yaml.dump(merged, { lineWidth: -1, noRefs: true });
}

function main(argv) {
  if (argv.length !== 3) {
    console.error("usage: node scripts/merge-update-yml.mjs <x64 stable.yml> <arm64 stable.yml> <out stable.yml>");
    return 2;
  }
  const [x64Path, armPath, outPath] = argv.map((p) => resolve(p));
  const out = mergeUpdateYml(readFileSync(x64Path, "utf8"), readFileSync(armPath, "utf8"));
  writeFileSync(outPath, out);
  console.log(`merged ${x64Path} + ${armPath} → ${outPath}`);
  console.log(out);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`merge-update-yml: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
