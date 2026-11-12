#!/usr/bin/env node
// Lint a post draft for one platform and print the findings as JSON.
// Usage: node post-lint.mjs --platform <x|linkedin|hn|reddit> (--file <path> | --text <draft>)
// Draft format: reddit/hn = title line, blank line, body; x = posts split by
// a line "---"; linkedin = the whole post. Read-only: it never posts.

import { readFileSync } from "node:fs";

const LONG_DASHES = /[\u2014\u2013]/g;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const URL_RE = /https?:\/\/\S+/g;
const X_URL_WEIGHT = 23;
const LINKEDIN_FOLD = 210;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--platform" || key === "--file" || key === "--text") {
      out[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

// Code points, not UTF-16 units, so an emoji is not counted as two by accident.
const len = (s) => [...s].length;

// X weights: a URL is 23, CJK and emoji count 2, everything else 1.
function xLength(post) {
  const urls = post.match(URL_RE) ?? [];
  let n = urls.length * X_URL_WEIGHT;
  for (const ch of post.replace(URL_RE, "")) {
    n += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return n;
}

function splitTitle(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const title = (lines.shift() ?? "").trim();
  return { title, body: lines.join("\n").trim() };
}

function count(re, s) {
  return (s.match(re) ?? []).length;
}

function lintDraft(platform, rawText) {
  const text = rawText.replace(/\r\n/g, "\n").trim();
  const errors = [];
  const warnings = [];
  const stats = {};

  const dashes = count(LONG_DASHES, text);
  stats.longDashes = dashes;
  if (dashes > 0) {
    errors.push(`${dashes} long dash(es) (U+2014/U+2013): use a period, comma, colon or parentheses`);
  }
  const hashtags = count(HASHTAG, text);
  stats.hashtags = hashtags;
  stats.links = count(URL_RE, text);

  if (platform === "x") {
    const posts = text.split(/\n-{3,}\n/).map((p) => p.trim()).filter(Boolean);
    stats.posts = posts.length;
    stats.postLengths = posts.map(xLength);
    stats.postLengths.forEach((n, i) => {
      if (n > 280) errors.push(`post ${i + 1} is ${n}/280 characters`);
    });
    if (hashtags > 1) warnings.push(`${hashtags} hashtags: use zero or one`);
    if (posts.length > 0 && count(URL_RE, posts[0]) > 0) {
      warnings.push("link in the first post: many accounts put it in the first reply");
    }
  } else if (platform === "linkedin") {
    stats.length = len(text);
    if (stats.length > 3000) errors.push(`post is ${stats.length}/3000 characters`);
    stats.beforeFold = [...text].slice(0, LINKEDIN_FOLD).join("");
    if (hashtags > 3) warnings.push(`${hashtags} hashtags: use three or fewer`);
    if (/\*\*|^#{1,6} /m.test(text)) warnings.push("markdown does not render on LinkedIn");
    if (/[\u{1D400}-\u{1D7FF}]/u.test(text)) {
      warnings.push("Unicode bold/italic letters: screen readers cannot read them");
    }
  } else if (platform === "hn") {
    const { title, body } = splitTitle(text);
    stats.titleLength = len(title);
    if (title === "") errors.push("missing title on the first line");
    if (stats.titleLength > 80) errors.push(`title is ${stats.titleLength}/80 characters`);
    if (/!/.test(title)) warnings.push("exclamation mark in the title");
    if (/\b[A-Z]{4,}\b/.test(title.replace(/^Show HN:|^Ask HN:/, ""))) {
      warnings.push("uppercase word in the title: HN asks not to shout");
    }
    if (/^show hn/i.test(title) && !title.startsWith("Show HN: ")) {
      errors.push('a Show HN title starts with exactly "Show HN: "');
    }
    if (/upvote|vote for/i.test(text)) errors.push("asks for votes: HN penalizes that");
    if (hashtags > 0) warnings.push("hashtags are not used on HN");
    stats.bodyLength = len(body);
  } else if (platform === "reddit") {
    const { title, body } = splitTitle(text);
    stats.titleLength = len(title);
    stats.bodyLength = len(body);
    if (title === "") errors.push("missing title on the first line");
    if (stats.titleLength > 300) errors.push(`title is ${stats.titleLength}/300 characters`);
    if (stats.bodyLength > 40000) errors.push(`body is ${stats.bodyLength}/40000 characters`);
    if (hashtags > 0) warnings.push("hashtags are not used on Reddit");
    if (/upvote/i.test(text)) warnings.push("asks for upvotes: against Reddit rules");
  } else {
    errors.push(`unknown platform "${platform}": use x, linkedin, hn or reddit`);
  }

  return { platform, ok: errors.length === 0, errors, warnings, stats };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let text = args.text;
  if (text === undefined && args.file !== undefined) text = readFileSync(args.file, "utf8");
  if (!args.platform || text === undefined) {
    console.log(JSON.stringify({ error: "usage: post-lint.mjs --platform <x|linkedin|hn|reddit> (--file <path> | --text <draft>)" }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(lintDraft(args.platform.toLowerCase(), text), null, 2));
}

main();
