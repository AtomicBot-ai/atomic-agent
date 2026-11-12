/**
 * Check a folder of desktop build files before it goes up to the update feed
 * (the `desktop-latest` release), and print the upload order (ATO-1230).
 *
 * The desktop workflow writes one update file per platform and uploads it
 * with the installers as a workflow artifact:
 *
 *   <channel>-mac.yml            macOS (installs the -mac.zip)
 *   <channel>.yml                Windows, x64 + arm64 MERGED (merge-update-yml.mjs)
 *   <channel>-linux.yml          Linux x64 AppImage
 *   <channel>-linux-arm64.yml    Linux arm64 AppImage
 *
 * electron-updater reads exactly these names (`<channel>-linux.yml` on x64,
 * `<channel>-linux-<arch>.yml` elsewhere). The 0.0.7 feed went up with the mac
 * and Windows files only, so every AppImage looked for `stable-linux.yml`,
 * got a 404 and never updated. This script refuses such a folder: every
 * platform's yml must be there, every file a yml names must be there next to
 * it, and the Windows yml must list both arches.
 *
 * When the folder holds a `SHA256SUMS.txt` ("<sha256>  <name>" lines, the
 * format the desktop release page uses), every file it lists must be in the
 * folder with that hash, and every feed file must be listed (ATO-685).
 * `--require-sums` makes a missing `SHA256SUMS.txt` a problem too; the
 * desktop-feed workflow passes it. A `.zip` or `.exe` without its `.blockmap`
 * is a warning only: the update still works, as a full download.
 *
 * Usage (desktop/; no dependencies, so it runs without `npm ci`):
 *   node scripts/feed-files.mjs <folder> [--channel stable] [--require-sums] [--json]
 *
 * It prints the files to upload, installers first and the `.yml` files last,
 * as two `gh release upload` lines (with `--json`: one JSON object
 * `{ uploadFirst, uploadLast, warnings }` for a workflow to read). Exit 1 with
 * the list of problems when the folder is not a complete feed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The update files one channel needs, by platform, under electron-updater's names. */
export function feedYmlNames(channel = "stable") {
  if (!/^[a-z0-9-]+$/.test(channel)) throw new Error(`not a channel name: ${channel}`);
  return {
    mac: `${channel}-mac.yml`,
    windows: `${channel}.yml`,
    "linux-x64": `${channel}-linux.yml`,
    "linux-arm64": `${channel}-linux-arm64.yml`,
  };
}

/**
 * The `url:` entries of an electron-builder update file (files[].url and the
 * legacy top-level `path:`). A line-level read on purpose: the files are flat
 * and this keeps the script free of js-yaml.
 */
export function namedFiles(ymlText) {
  const names = new Set();
  for (const line of ymlText.split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?(?:url|path):\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

export function ymlVersion(ymlText) {
  const m = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(ymlText);
  return m ? m[1] : null;
}

/**
 * Check a feed folder. `files` is the folder's file names, `read(name)` the
 * text of one of them. Returns { problems, uploadFirst, uploadLast }.
 */
export function checkFeed(files, read, channel = "stable") {
  const present = new Set(files);
  const ymls = feedYmlNames(channel);
  const problems = [];
  const installers = new Set();
  const versions = new Map();

  for (const [platform, yml] of Object.entries(ymls)) {
    if (!present.has(yml)) {
      problems.push(`${platform}: ${yml} is missing (the ${platform} app would find no update)`);
      continue;
    }
    const text = read(yml);
    const named = namedFiles(text);
    if (named.length === 0) problems.push(`${yml}: names no file (not an electron-builder update file?)`);
    versions.set(yml, ymlVersion(text));
    for (const name of named) {
      if (/\s/.test(name)) problems.push(`${yml}: ${name} has a space; GitHub renames it on upload and the url 404s`);
      if (!present.has(name)) problems.push(`${yml}: names ${name}, which is not in the folder`);
      else installers.add(name);
      if (present.has(`${name}.blockmap`)) installers.add(`${name}.blockmap`);
    }
    if (platform === "windows" && !(named.some((n) => /-x64\.exe$/.test(n)) && named.some((n) => /-arm64\.exe$/.test(n)))) {
      problems.push(`${yml}: does not list both the x64 and the arm64 installer (merge the two jobs' files with merge-update-yml.mjs)`);
    }
    if (platform.startsWith("linux") && !named.some((n) => n.endsWith(".AppImage"))) {
      problems.push(`${yml}: names no .AppImage`);
    }
  }

  const distinct = new Set([...versions.values()].filter(Boolean));
  if (distinct.size > 1) {
    problems.push(`the update files carry different versions: ${[...versions].map(([f, v]) => `${f}=${v}`).join(", ")}`);
  }

  const warnings = [];
  for (const name of installers) {
    if (/\.(zip|exe)$/.test(name) && !present.has(`${name}.blockmap`)) {
      warnings.push(`${name} has no .blockmap: updates download the whole file`);
    }
  }
  if (present.has(SUMS)) installers.add(SUMS);

  return {
    problems,
    warnings,
    uploadFirst: [...installers].sort(),
    uploadLast: Object.values(ymls).filter((y) => present.has(y)),
  };
}

export const SUMS = "SHA256SUMS.txt";

/** "<sha256>  <name>" lines (sha256sum's format, `*` for binary mode allowed) to a Map name -> hash. */
export function parseSums(text) {
  const sums = new Map();
  const bad = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
    else bad.push(line);
  }
  return { sums, bad };
}

/**
 * Check a folder's SHA256SUMS.txt against its files (ATO-685). `feedFiles` are
 * the files the feed uploads (checkFeed's uploadFirst + uploadLast, without
 * the sums file itself); `hash(name)` returns a file's sha256 in hex.
 */
export function checkSums(files, sumsText, feedFiles, hash) {
  const present = new Set(files);
  const problems = [];
  const { sums, bad } = parseSums(sumsText);
  for (const line of bad) problems.push(`${SUMS}: not a "<sha256>  <name>" line: ${line}`);
  for (const [name, digest] of sums) {
    if (!present.has(name)) problems.push(`${SUMS}: lists ${name}, which is not in the folder`);
    else if (hash(name) !== digest) problems.push(`${SUMS}: ${name} does not match its sha256`);
  }
  for (const name of feedFiles) {
    if (name === SUMS || name.endsWith(".yml") || name.endsWith(".blockmap")) continue;
    if (!sums.has(name)) problems.push(`${SUMS}: does not list ${name}`);
  }
  return problems;
}

function main(argv) {
  let channel = "stable";
  let requireSums = false;
  let json = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--channel") channel = argv[++i] ?? "";
    else if (argv[i] === "--require-sums") requireSums = true;
    else if (argv[i] === "--json") json = true;
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) {
    console.error("usage: node scripts/feed-files.mjs <folder> [--channel stable] [--require-sums] [--json]");
    return 2;
  }
  const dir = resolve(rest[0]);
  const files = readdirSync(dir);
  const read = (name) => readFileSync(join(dir, name), "utf8");
  const { problems, warnings, uploadFirst, uploadLast } = checkFeed(files, read, channel);
  if (files.includes(SUMS)) {
    const hash = (name) => createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    problems.push(...checkSums(files, read(SUMS), [...uploadFirst, ...uploadLast], hash));
  } else if (requireSums) {
    problems.push(`${SUMS} is missing`);
  }
  for (const w of warnings) console.error(`feed-files: warning: ${w}`);
  if (problems.length > 0) {
    console.error(`feed-files: ${dir} is not a complete ${channel} feed:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ uploadFirst, uploadLast, warnings }));
    return 0;
  }
  const quote = (names) => names.map((n) => JSON.stringify(n)).join(" ");
  console.log(`# ${dir}: complete ${channel} feed. Installers first, the .yml files last:`);
  console.log(`gh release upload desktop-latest ${quote(uploadFirst)} --repo AtomicBot-ai/atomic-agent --clobber`);
  console.log(`gh release upload desktop-latest ${quote(uploadLast)} --repo AtomicBot-ai/atomic-agent --clobber`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`feed-files: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
