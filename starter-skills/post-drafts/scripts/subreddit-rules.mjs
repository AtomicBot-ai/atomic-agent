#!/usr/bin/env node
// Fetch a subreddit's public rules and sidebar and print them as JSON.
// Usage: node subreddit-rules.mjs <subreddit>   (with or without "r/")
// Read-only: two GET requests to reddit.com, nothing is posted.

const MAX_TEXT = 6000;
const UA = "post-drafts/1.0 (draft helper; read-only)";

function clip(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[truncated]` : t;
}

function normaliseSubreddit(raw) {
  const name = String(raw ?? "")
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/\/+$/, "");
  return /^[A-Za-z0-9_]{2,21}$/.test(name) ? name : null;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() };
}

async function main() {
  const sub = normaliseSubreddit(process.argv[2]);
  if (sub === null) {
    console.log(
      JSON.stringify({ error: "usage: subreddit-rules.mjs <subreddit>" }),
    );
    process.exitCode = 2;
    return;
  }
  const base = `https://www.reddit.com/r/${sub}/about`;
  const [rules, about] = await Promise.all([
    getJson(`${base}/rules.json`),
    getJson(`${base}.json`),
  ]);
  if (rules.body === null && about.body === null) {
    console.log(
      JSON.stringify({
        subreddit: sub,
        error: `reddit refused both requests (rules ${rules.status}, about ${about.status})`,
        next: "fetch the URLs with os.http.request, or ask the user to paste the rules and sidebar",
      }),
    );
    process.exitCode = 1;
    return;
  }
  const info = about.body?.data ?? {};
  const out = {
    subreddit: sub,
    rules: (rules.body?.rules ?? []).map((r) => ({
      name: r.short_name ?? "",
      appliesTo: r.kind ?? "all",
      description: clip(r.description ?? ""),
    })),
    siteRules: rules.body?.site_rules ?? [],
    sidebar: {
      title: info.title ?? "",
      publicDescription: clip(info.public_description ?? ""),
      description: clip(info.description ?? ""),
      submitText: clip(info.submit_text ?? ""),
      submissionType: info.submission_type ?? "",
      subredditType: info.subreddit_type ?? "",
      over18: info.over18 ?? false,
      linkFlairEnabled: info.link_flair_enabled ?? false,
      subscribers: info.subscribers ?? null,
    },
    missing: [
      ...(rules.body === null ? [`rules (HTTP ${rules.status})`] : []),
      ...(about.body === null ? [`sidebar (HTTP ${about.status})`] : []),
    ],
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.log(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exitCode = 1;
});
