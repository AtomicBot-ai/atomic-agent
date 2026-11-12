---
name: seo-audit
description: "Check a website's SEO and say what to fix first, split into quick wins and strategic work. Use for 'check my site' or /seo-audit."
version: 1.0.0
requires_tools:
  - skill.run_script
requires_scripts:
  - crawl.mjs
  - pagespeed.mjs
dangerous: false
---

# seo-audit

A list of 80 SEO warnings tells the owner nothing about where to start.
This skill crawls a small part of the site politely, checks the basics a
search engine reads, measures speed with Google's free PageSpeed API and
hands back a short report: what takes minutes to fix, and what takes real
work, each with the pages it affects.

## Read-only and polite

The audit only reads the site. These rules are built into `crawl.mjs`; do
not work around them with other tools:

- GET and HEAD requests only. Never submit a form, log in, post a comment,
  add to a cart or follow a link that changes something.
- robots.txt is read first and obeyed for the `AtomicAgent-SEO-Audit` user
  agent (or `*`). If robots.txt blocks the whole site, stop and say so. If
  robots.txt cannot be reached (server error, timeout), the script stops:
  report that and do not crawl another way.
- Small page cap (20 pages by default, 50 at most) and a delay between
  every request (1 second by default, never under 0.5 seconds, longer when
  robots.txt sets `Crawl-delay`).
- Requests identify themselves as `AtomicAgent-SEO-Audit/1.0`.

Audit only a site the user named. If they point at a site they do not own,
that is fine for a read-only check, but keep the defaults: no bigger caps,
no shorter delay.

## Step 1: crawl

Run the crawl with the site the user gave (a bare domain works):

```json
[{ "tool": "skill.run_script", "args": { "skill": "seo-audit", "script": "crawl.mjs", "args": ["example.com"], "timeoutMs": 300000 } }]
```

Optional args: `--max-pages N` (up to 50), `--max-links N` (up to 300),
`--delay-ms N`. Raise the caps only when the user asks for a deeper
audit, and then use `timeoutMs: 600000`.

The script reads the sitemap from robots.txt (or `/sitemap.xml`), fetches
the home page and sitemap pages up to the cap (when there is no sitemap it
follows internal links), then checks the links it found with HEAD. It
prints one JSON object:

- `site`: origin, robots.txt status, whether robots.txt blocks the site,
  the delay used, whether a sitemap was found.
- `findings`: one entry per problem, with `check`, `count`, up to 20 `urls`
  and matching `details` (a length, a status, a canonical target).
- `pages`: a short line per crawled page. `linkProblems`: broken or
  redirecting links with the pages they were found on.
- `limits`: how many pages and links were crawled and checked. If the
  site has more pages than the cap, say the report covers a sample.

If the output has `error`, report it plainly and stop.

## Step 2: speed (Core Web Vitals)

Run PageSpeed for the home page, then for at most two other important
pages from the crawl (a product page, a blog post), one call at a time:

```json
[{ "tool": "skill.run_script", "args": { "skill": "seo-audit", "script": "pagespeed.mjs", "args": ["https://example.com/"], "timeoutMs": 150000 }}]
```

Add `--strategy desktop` only if the user asks about desktop. The script
returns `performanceScore` (0 to 100), `fieldData` (real-user Core Web
Vitals at the 75th percentile, when Google has enough traffic data; CLS is
`clsX100`, divide by 100), `originFieldData` (the same for the whole site),
`lab` numbers and the top `opportunities` with estimated savings.

Good thresholds: LCP up to 2500 ms, INP up to 200 ms, CLS up to 0.1. Prefer
field data over lab data when both exist, and say which one you used.

**API key.** PageSpeed works without a key at low volume, but the keyless
quota is shared and is often used up (`error: rate_limited`). Then:

1. Do not retry in a loop. Write "Speed: not measured" in the report.
2. Tell the user they can get a free key from Google Cloud (enable the
   "PageSpeed Insights API", create an API key), put
   `PAGESPEED_API_KEY=...` in `~/.atomic-agent/.env`, and add
   `PAGESPEED_API_KEY` to `tools.shell.envPassthrough` in the config so
   skill scripts can see it (scripts get a filtered environment and
   secret-looking variables are removed unless listed there).
3. Offer the manual check: https://pagespeed.web.dev/ with their URL.

Never ask the user to paste the key into the chat, and never pass it as a
script argument.

## Step 3: sort into quick wins and strategic

Each `check` goes into one bucket. Quick wins are template or text edits a
person can do in under an hour; strategic items need design, content or
engineering work, or a decision.

| check | bucket | what it means |
|---|---|---|
| `robots_blocks_site`, `sitemap_url_noindex`, `noindex` | quick win, report first | pages are hidden from search; confirm it is not on purpose |
| `missing_title`, `multiple_titles`, `title_too_long`, `title_too_short` | quick win | title missing, doubled, over 60 or under 15 characters |
| `missing_description`, `description_too_long`, `description_too_short` | quick win | meta description missing, over 160 or under 50 characters |
| `missing_h1`, `multiple_h1` | quick win | no H1, or several |
| `missing_canonical`, `canonical_points_elsewhere`, `canonical_other_host` | quick win | canonical missing or pointing at another URL; check the target is meant |
| `invalid_json_ld` | quick win | a JSON-LD block does not parse, so search engines ignore it |
| `missing_lang`, `missing_viewport`, `images_missing_alt` | quick win | no `lang`, no mobile viewport, images without `alt` |
| `broken_internal_link`, `internal_link_redirects` | quick win | fix or point the link at the final URL |
| `broken_external_link` | quick win | replace or remove the link |
| `no_sitemap`, `sitemap_url_broken`, `sitemap_url_redirects` | quick win | the sitemap is missing or lists URLs that fail or redirect |
| `duplicate_title`, `duplicate_description` | strategic when many pages share one template, else quick win | pages compete with each other |
| `no_structured_data` | strategic | add schema (Organization, Product, Article, FAQ) that fits the page type |
| `page_error` | strategic if it is a template or server problem, else quick win | pages that return an error |
| poor Core Web Vitals, low `performanceScore` | strategic | speed work; name the top `opportunities` |

## Report

Start with two lines: the site, how many pages and links were checked (and
that it is a sample if the cap was hit), and the speed result in one
sentence ("Mobile LCP 3.4 s from real users, needs work").

Then two sections, in this order:

### Quick wins

Most important first: indexing problems, then broken things, then titles
and descriptions, then the rest. For each item:

- **What to fix**, in plain words, and why it matters in one sentence.
- **Affected URLs**: list them (up to 10, then "and N more"). Use the
  `details` where they help ("title is 74 characters").
- **How**: the concrete change, for example the exact tag to add.

### Strategic

Same format, plus a rough size (small, medium, large) and what it depends
on.

End with one line on what the audit did not cover: pages past the cap,
JavaScript-rendered content (the crawl reads the HTML the server sends),
backlinks, rankings and keyword research. If nothing was found in a
section, say "None found" rather than inventing filler.

## Rules

- Report only what the script output shows. Do not guess problems on pages
  that were not crawled, and do not invent traffic or ranking numbers.
- Group by fix, not by page: one item with ten URLs beats ten items.
- Do not edit the site's code or content as part of the audit. If the
  user's site lives in the working directory and they want fixes, offer
  them after the report, as a separate step.
