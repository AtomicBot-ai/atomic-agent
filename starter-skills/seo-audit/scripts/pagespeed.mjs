#!/usr/bin/env node
// Core Web Vitals for one URL from the free Google PageSpeed Insights v5
// API. Works without a key at low volume; uses PAGESPEED_API_KEY when it
// is in the environment. The key is never printed. Prints one JSON object.
//
// Usage: node pagespeed.mjs <url> [--strategy mobile|desktop]

import { summarizePageSpeed } from "./seo-lib.mjs";

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

async function main() {
  const argv = process.argv.slice(2);
  const url = argv.find((a) => !a.startsWith("--"));
  const i = argv.indexOf("--strategy");
  const strategy = i >= 0 && argv[i + 1] === "desktop" ? "desktop" : "mobile";
  if (!url || !/^https?:\/\//i.test(url)) {
    console.log(JSON.stringify({ error: "usage: pagespeed.mjs <https://url> [--strategy mobile|desktop]" }));
    process.exitCode = 2;
    return;
  }
  const key = process.env.PAGESPEED_API_KEY?.trim();
  const query = new URLSearchParams({ url, strategy, category: "performance" });
  if (key) query.set("key", key);
  let res;
  try {
    res = await fetch(`${ENDPOINT}?${query}`, { signal: AbortSignal.timeout(120000) });
  } catch (err) {
    console.log(JSON.stringify({ url, strategy, error: "request_failed", detail: String(err?.cause?.code ?? err?.name ?? err) }));
    process.exitCode = 1;
    return;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const out = { url, strategy, usedKey: Boolean(key), error: res.status === 429 ? "rate_limited" : "api_error", status: res.status };
    out.detail = String(body?.error?.message ?? "").slice(0, 300);
    if (res.status === 429 && !key) out.hint = "The keyless quota is shared by everyone and is often used up. A free PAGESPEED_API_KEY fixes this (see the skill).";
    console.log(JSON.stringify(out));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ usedKey: Boolean(key), ...summarizePageSpeed(body, strategy) }));
}

main().catch((err) => {
  console.log(JSON.stringify({ error: "pagespeed_failed", detail: String(err?.message ?? err) }));
  process.exitCode = 1;
});
