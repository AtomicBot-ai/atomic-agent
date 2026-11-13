---
name: traffic-analytics
description: "Why did traffic drop? Reports from the user's own GA4, Search Console and PostHog: drop diagnosis, rising queries, keyword cannibalization, funnels. Never invents numbers."
version: 1.0.0
requires_tools:
  - skill.run_script
  - os.fs.read
requires_scripts:
  - analytics-query.mjs
dangerous: false
---

# traffic-analytics

Answer questions about the user's own site or product with real data:
"why did traffic drop", "which queries are growing", "are two of my pages
fighting for one keyword", "where do people drop out of the funnel". The
data comes from the official APIs with the user's own credentials:

- **GA4**: Data API `runReport`.
- **Search Console**: `searchanalytics.query`.
- **PostHog**: the query API with a HogQL query.

## The rule: no invented numbers

Every number you write must come from a query result in this conversation.
Do not estimate, round up from memory, fill a gap with an industry average
or "typical" value, or describe a trend you did not query. If a source is
not connected, say so, say exactly what is needed to connect it (see
Setup), and answer only from the sources that did return data. A cause you
cannot prove from the data is a **hypothesis** and is labelled as one.

## How to call it

All requests go through one script. Credentials stay in a local file the
user fills in, so they never appear in the chat and never in tool output.

```json
[{ "tool": "skill.run_script", "args": { "skill": "traffic-analytics", "script": "analytics-query.mjs", "args": ["check"] } }]
```

| Args | What it does |
|---|---|
| `["check"]` | Says which of `ga4`, `gsc`, `posthog` is ready and what each one still needs. Prints no secrets. |
| `["init"]` | Creates the credentials file from a template (mode 600) if it is missing and prints its path. |
| `["ga4", "<runReport JSON>"]` | POST to `properties/<id>:runReport`. The property comes from the file. |
| `["gsc", "<query JSON>"]` | POST to `sites/<site>/searchAnalytics/query`. The site comes from the file. |
| `["posthog", "<HogQL>"]` | POST `{"query":{"kind":"HogQLQuery","query":...}}` to `/api/projects/<id>/query/`. |
| `["compare", "gsc" or "ga4", "<current.json>", "<previous.json>", "--order", "abs"]` | Joins two saved results by row and lists the biggest changes. `--metric` (default `impressions` for gsc, the first metric for ga4), `--order abs`, `growth` or `drop`, `--min <n>` to skip small rows. |
| `["cannibalization", "<query-page.json>"]` | Finds queries where 2+ pages each get at least 10% of the impressions. `--min-share 0.1`, `--min-impressions 100`. |

**Output is short on purpose.** Every query saves the full response under
`~/.atomic-agent/traffic-analytics/results/` (mode 600) and prints only
`saved: <path>` plus a summary of at most 30 rows. You see only a few
thousand characters of tool output, so do joins and grouping with
`compare` and `cannibalization` on the saved files instead of asking for
everything on screen. Pass the exact `saved:` paths. Add `--raw` only for
small responses you need whole.

Exit code 2 with `status: missing_setup` or `status: no_config` means the
source is not connected: stop querying it and go to Setup. Exit code 1 is an
API error; read the message (403 usually means the service account was not
added to that property or site).

Run `check` once at the start, not before every query. If `check` warns
that the credentials file can be read by other users, run `init`: it sets
the file to mode 600.

## Setup (only when `check` says something is missing)

1. Run `init`. It prints the file path, by default
   `~/.atomic-agent/traffic-analytics.json`.
2. Tell the user which fields are missing and how to get them, then ask
   them to open the file and fill them in **themselves**. Do not ask them
   to paste keys into the chat. Do not fill in key values yourself.
3. Run `check` again when they say it is done.

How to get each value:

- **Google (GA4 and Search Console), service account, recommended.**
  In Google Cloud Console create a project, enable "Google Analytics Data
  API" and "Google Search Console API", create a service account, and
  download a JSON key. Put the key file's full path in
  `google.serviceAccountFile`. Then give that service account's email
  read access: in GA4, Admin > Property access management > add it as
  Viewer; in Search Console, Settings > Users and permissions > add it
  (Restricted is enough).
- **Google, short-lived token instead.** If the user already uses
  `gcloud`, `gcloud auth print-access-token` with the analytics and
  webmasters read-only scopes gives a token for `google.accessToken`. It
  expires after about an hour.
- **`ga4PropertyId`**: the number in GA4 Admin > Property details (not the
  `G-` measurement ID).
- **`gscSiteUrl`**: `sc-domain:example.com` for a domain property, or the
  exact prefix with a trailing slash, `https://example.com/`, for a
  URL-prefix property.
- **PostHog**: Settings > Personal API keys > create a key with the
  `query:read` scope for `posthog.personalApiKey`; the project ID is the
  number in the project URL; `posthog.host` is `https://us.posthog.com` or
  `https://eu.posthog.com` (or the self-hosted URL).

**Optional other paths.** If an MCP server or a Composio toolkit for GA4,
Search Console or PostHog is already connected in this agent, you may use
its tools instead. If the `gog-workspace` skill is signed in with the
`analytics` and `searchconsole` services, its `gog analytics` and
`gog searchconsole` commands are another route (read their flags with
`gog schema analytics --json` first). The same rule applies: only numbers that tool returned.
Do not tell the user a given toolkit works unless a call to it just did.

## Before any report

- Write down the exact date ranges you compare. Compare equal lengths that
  start on the same weekday (for example 28 days against the 28 before).
- Search Console data lags 2 to 3 days. End Search Console ranges 3 days
  before today, and GA4 ranges yesterday (today is partial).
- Say which source each number came from. GA4 sessions, Search Console
  clicks and PostHog events are different counts and will not match.

## Recipe 1: why did traffic drop

1. **Confirm the drop and date it.** GA4 by day, one request per range
   (28 rows each fit in the summary):

   ```json
   {"dateRanges":[{"startDate":"2026-10-15","endDate":"2026-11-11"}],"dimensions":[{"name":"date"}],"metrics":[{"name":"sessions"},{"name":"totalUsers"}],"orderBys":[{"dimension":{"dimensionName":"date"}}],"limit":100}
   ```

   Then the same for the previous range. Find the day it started: a cliff
   on one day points to a change (release, tracking, migration, outage); a
   slow slide points to rankings or demand.
2. **Find where it happened.** One request per range and dimension,
   metric `sessions`: `sessionDefaultChannelGroup`, then `landingPage`,
   `country`, `deviceCategory`, `sessionSource`. Then run
   `["compare", "ga4", "<current saved path>", "<previous saved path>", "--order", "drop"]`
   for each. The drop usually sits in one or two rows.
3. **If organic search fell, open Search Console.** One query per range
   with `"dimensions":["page"]` and then `["query"]`:

   ```json
   {"startDate":"2026-10-15","endDate":"2026-11-09","dimensions":["page"],"rowLimit":1000,"dataState":"final"}
   ```

   Run `compare gsc` on the two saved files, once with `--metric clicks`
   and once with `--metric impressions` (add `--metric position` for the
   pages that moved). Read the pattern:

   | Pattern | Likely meaning (hypothesis until checked) |
   |---|---|
   | Impressions down, position about the same | Less demand or seasonality. |
   | Position down on a group of pages | Ranking loss; check those pages and their competitors. |
   | Impressions stable, CTR down | Snippet or results-page change (title, AI answer, new feature above). |
   | One page went to zero | Page removed, redirected, noindexed or not indexed. |
   | Search Console flat, GA4 organic down | Tracking problem, not traffic: check the GA4 tag and consent banner. |
   | Every channel down on the same day | Site-wide: tracking change, outage, or a release. |
4. **Segment the cause.** Re-run the key query filtered to the segment that
   moved, for example only mobile or one country:

   ```json
   {"startDate":"2026-10-15","endDate":"2026-11-09","dimensions":["query"],"dimensionFilterGroups":[{"filters":[{"dimension":"device","operator":"equals","expression":"MOBILE"},{"dimension":"country","operator":"equals","expression":"usa"}]}],"rowLimit":500}
   ```

   Search Console countries are lowercase three-letter codes (`usa`,
   `deu`); devices are `DESKTOP`, `MOBILE`, `TABLET`.
5. **Report**: the total change with both ranges, a table of the 3 to 10
   segments that explain most of it, what the pattern suggests (labelled
   hypothesis), and the next check that would confirm it.

## Recipe 2: fast-rising queries

1. Search Console `"dimensions":["query"]`, `"rowLimit":5000`, for the last
   28 days and for the 28 before. The full rows are saved; only the summary
   is printed.
2. Join and sort in the script, not by hand:
   `["compare", "gsc", "<current saved path>", "<previous saved path>", "--metric", "impressions", "--order", "growth", "--min", "50"]`.
   Rows marked `[new]` had no row in the previous range. Say the threshold
   you used. Run it again with `--metric clicks` if clicks matter more.
3. Show the top 20 with current and previous impressions and clicks, and
   the page that ranks (re-query with `["query","page"]` and a filter on
   those queries if needed).
4. Point out queries with many impressions and position worse than 10:
   demand exists, the page is not yet on page one.

## Recipe 3: keyword cannibalization

Cannibalization means several of the user's own pages rank for the same
query and split the clicks.

1. Search Console `"dimensions":["query","page"]`, last 28 days,
   `"rowLimit":25000` (the maximum; page with `startRow` if there are more
   rows). The full rows are saved; only the summary is printed.
2. Run `["cannibalization", "<saved path>"]`. It flags a query when two or
   more pages each have at least 10% of that query's impressions and skips
   queries under 100 total impressions (change with `--min-share` and
   `--min-impressions`, and state the thresholds you used).
3. For each flagged query show the pages with impressions, clicks and
   position from the script output. Strong signs: positions close together, or the pages swapping
   places over time (re-query that query by `["date","page"]` to see it).
4. Brand-name queries often match many pages and are rarely a problem;
   list them separately.
5. Suggest, do not decide: merge the pages, make one the clear target and
   link to it from the other, or change one page's topic. The user picks.

## Recipe 4: PostHog funnel

1. **Do not guess event names.** List them first:

   ```sql
   SELECT event, count() AS n FROM events WHERE timestamp > now() - INTERVAL 14 DAY GROUP BY event ORDER BY n DESC LIMIT 50
   ```

2. Ask the user which events are the steps if it is not obvious. Then count
   people who did each step after the previous one within a window:

   ```sql
   SELECT
     count() AS step_1,
     countIf(t2 > t1 AND t2 < t1 + INTERVAL 7 DAY) AS step_2,
     countIf(t2 > t1 AND t3 > t2 AND t3 < t1 + INTERVAL 7 DAY) AS step_3
   FROM (
     SELECT person_id,
       minIf(timestamp, event = 'signed_up') AS t1,
       minIf(timestamp, event = 'project_created') AS t2,
       minIf(timestamp, event = 'invite_sent') AS t3
     FROM events
     WHERE timestamp >= now() - INTERVAL 30 DAY
     GROUP BY person_id
   )
   WHERE t1 > toDateTime('2000-01-01')
   ```

   This uses each person's first time per step, so it is a close
   approximation of PostHog's own funnel insight, not an exact copy. Say so.
3. Split by a property when asked, for example
   `properties.$os` or `properties.$browser` in the inner query and a
   `GROUP BY` in the outer one.
4. Report each step's count and the conversion from the previous step, and
   name the biggest drop. To compare two periods, run the query once per
   period.

## What to report

A short answer first (shape only, not real data: "Organic clicks fell 31% from Oct 18; 80% of the loss
is three blog pages that lost positions"), then the tables, then the
hypotheses and the next checks. Every number has its source and date range.
If a source was missing, end with one line saying which and what would
connect it.
