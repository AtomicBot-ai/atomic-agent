/**
 * Point the Flatpak manifest at a new desktop release (ATO-687).
 *
 *   node flatpak/bump.mjs <version>          (from desktop/)
 *
 * Downloads SHA256SUMS.txt of the desktop-v<version> release, rewrites the two
 * .deb sources of io.atomicagent.desktop.yml (url + sha256) and adds a
 * <release> line to the metainfo. No dependencies, no npm ci.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "AtomicBot-ai/atomic-agent";
const DEBS = { x86_64: "amd64", aarch64: "arm64" };

export function debName(version, flatpakArch) {
  return `Atomic-Agent-${version}-${DEBS[flatpakArch]}.deb`;
}

/** "<sha256>  <name>" lines to a Map name -> hash. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** Rewrite each arch's .deb url and sha256 in the manifest text. */
export function bumpManifest(text, version, sums) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  let out = text;
  for (const arch of Object.keys(DEBS)) {
    const name = debName(version, arch);
    const sha = sums.get(name);
    if (!sha) throw new Error(`SHA256SUMS.txt of desktop-v${version} has no ${name}`);
    const block = new RegExp(
      `(only-arches: \\[${arch}\\]\\n(?:\\s+[a-z-]+: .*\\n)*?\\s+url: )\\S+(\\n\\s+sha256: )[0-9a-f]{64}`,
    );
    if (!block.test(out)) throw new Error(`manifest has no ${arch} .deb source`);
    out = out.replace(block, `$1https://github.com/${REPO}/releases/download/desktop-v${version}/${name}$2${sha}`);
  }
  return out;
}

/** Add <release version date/> first in <releases>, once. */
export function addRelease(xml, version, date) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error(`not a date: ${date}`);
  if (xml.includes(`<release version="${version}"`)) return xml;
  if (!xml.includes("<releases>\n")) throw new Error("metainfo has no <releases>");
  return xml.replace("<releases>\n", `<releases>\n    <release version="${version}" date="${date}"/>\n`);
}

async function main(argv) {
  const version = argv[0];
  if (!version) {
    console.error("usage: node flatpak/bump.mjs <version>");
    return 2;
  }
  const base = `https://github.com/${REPO}/releases/download/desktop-v${version}`;
  const res = await fetch(`${base}/SHA256SUMS.txt`);
  if (!res.ok) throw new Error(`${base}/SHA256SUMS.txt: HTTP ${res.status}`);
  const sums = parseSums(await res.text());
  const api = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/desktop-v${version}`);
  const date = api.ok ? String((await api.json()).published_at).slice(0, 10) : new Date().toISOString().slice(0, 10);

  const manifest = join(HERE, "io.atomicagent.desktop.yml");
  const metainfo = join(HERE, "io.atomicagent.desktop.metainfo.xml");
  writeFileSync(manifest, bumpManifest(readFileSync(manifest, "utf8"), version, sums));
  writeFileSync(metainfo, addRelease(readFileSync(metainfo, "utf8"), version, date));
  console.log(`flatpak: desktop-v${version} (${date})`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`flatpak/bump: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
