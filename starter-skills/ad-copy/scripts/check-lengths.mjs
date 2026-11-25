#!/usr/bin/env node
// Check ad copy against Google Ads (Responsive Search Ads) hard limits and
// Meta recommended lengths. Input: one JSON argument, or a path to a JSON file.
//
// {
//   "google": { "headlines": [...], "descriptions": [...], "paths": ["path1", "path2"] },
//   "meta":   { "primaryTexts": [...], "headlines": [...], "descriptions": [...] }
// }
//
// Prints one line per text and exits 1 when any Google hard limit is broken.
// Meta lengths are recommendations, so going over is a warning, not a failure.

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GOOGLE_LIMITS = { headlines: 30, descriptions: 90, paths: 15 };
export const GOOGLE_COUNTS = {
  headlines: { min: 3, max: 15 },
  descriptions: { min: 2, max: 4 },
  paths: { min: 0, max: 2 },
};
export const META_RECOMMENDED = { primaryTexts: 125, headlines: 40, descriptions: 30 };

// Google Ads counts double-width characters (CJK, full-width forms) as 2.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

export function googleLength(text) {
  let n = 0;
  for (const ch of text) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

export function plainLength(text) {
  return [...text].length;
}

export function checkAds(input) {
  const lines = [];
  let failed = false;
  const google = input.google ?? {};
  for (const [field, limit] of Object.entries(GOOGLE_LIMITS)) {
    const items = google[field];
    if (items === undefined) continue;
    const { min, max } = GOOGLE_COUNTS[field];
    if (items.length < min || items.length > max) {
      failed = true;
      lines.push(`FAIL google.${field}: ${items.length} given, allowed ${min} to ${max}`);
    }
    items.forEach((text, i) => {
      const len = googleLength(text);
      const ok = len <= limit;
      if (!ok) failed = true;
      lines.push(`${ok ? "ok  " : "FAIL"} google.${field}[${i}] ${len}/${limit}: ${text}`);
      if (field === "headlines" && text.includes("!")) {
        failed = true;
        lines.push(`FAIL google.${field}[${i}]: no exclamation marks in headlines`);
      }
    });
  }
  const meta = input.meta ?? {};
  for (const [field, limit] of Object.entries(META_RECOMMENDED)) {
    const items = meta[field];
    if (items === undefined) continue;
    items.forEach((text, i) => {
      const len = plainLength(text);
      lines.push(`${len <= limit ? "ok  " : "WARN"} meta.${field}[${i}] ${len}/${limit} recommended: ${text.split("\n")[0]}`);
    });
  }
  return { failed, lines };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write("usage: check-lengths.mjs '<json>' | <file.json>\n");
    process.exit(64);
  }
  const raw = existsSync(arg) ? readFileSync(arg, "utf8") : arg;
  const { failed, lines } = checkAds(JSON.parse(raw));
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(failed ? 1 : 0);
}
