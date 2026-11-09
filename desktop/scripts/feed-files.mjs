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
 * Usage (desktop/; no dependencies, so it runs without `npm ci`):
 *   node scripts/feed-files.mjs <folder> [--channel stable]
 *
 * It prints the files to upload, installers first and the `.yml` files last,
 * as two `gh release upload` lines. Exit 1 with the list of problems when the
 * folder is not a complete feed.
 */
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

  return {
    problems,
    uploadFirst: [...installers].sort(),
    uploadLast: Object.values(ymls).filter((y) => present.has(y)),
  };
}

function main(argv) {
  let channel = "stable";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--channel") channel = argv[++i] ?? "";
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) {
    console.error("usage: node scripts/feed-files.mjs <folder> [--channel stable]");
    return 2;
  }
  const dir = resolve(rest[0]);
  const files = readdirSync(dir);
  const { problems, uploadFirst, uploadLast } = checkFeed(files, (name) => readFileSync(join(dir, name), "utf8"), channel);
  if (problems.length > 0) {
    console.error(`feed-files: ${dir} is not a complete ${channel} feed:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
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
