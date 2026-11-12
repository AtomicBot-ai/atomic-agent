---
name: seo-rank-report
description: "Track Google positions for a keyword list and send a weekly Telegram report of what moved. Use for keyword positions, rank tracking or a weekly SEO report."
version: 0.1.0
requires_tools:
  - os.shell.run
  - os.fs.read
  - os.fs.write
  - browser.read_aria
  - tasks.cron
  - tasks.list
  - tasks.cancel
dangerous: false
---

# seo-rank-report

Answers "where do we rank for these keywords, and what changed since last
week", once on request and then every week in Telegram. Positions are kept
in a local SQLite file, so the weekly report compares against real history.

## Where things live

Everything this skill keeps goes in `~/.atomic-agent/seo-rank-report/` (or
`$ATOMIC_AGENT_STATE_DIR/seo-rank-report/` when the state dir is moved).
Never write into the skill folder `~/.atomic-agent/skills/seo-rank-report/`:
it is replaced on every agent start, so anything saved there is lost.

| File | What it holds |
|---|---|
| `config.json` | `{"domain", "source", "location_code", "language_code", "cron", "tz"}` |
| `keywords.txt` | one keyword per line, `#` starts a comment, up to ~50 |
| `history.sqlite` | every stored run, written only by `rank_history.py` |

The script is `~/.atomic-agent/skills/seo-rank-report/scripts/rank_history.py`.
Run it with `os.shell.run`, `cmd: "python3"` (`python` on Windows), the
script path as the first arg. It needs only Python 3, no packages, and
prints JSON. If `python3` is missing, say Python 3 is required and stop.

```
[{ "tool": "os.shell.run", "args": { "cmd": "python3", "args": ["~/.atomic-agent/skills/seo-rank-report/scripts/rank_history.py", "report", "--domain", "example.com"] } }]
```

## Setup (first time)

1. Ask for the **domain** (e.g. `example.com`) and the **keywords**. If the
   user has none, offer ideas from search suggestions:
   `rank_history.py suggest --q "<seed phrase>"`. Suggestions give keyword
   ideas only, never positions.
2. Write `keywords.txt` and `config.json` with `os.fs.write`. Read them back
   on later runs instead of asking again.
3. Pick the data source (next section), get one run, store it with
   `record`, and show the user the first table.
4. Offer the weekly report and create it (see "Weekly report").

## Data sources, in this order

Use the first one that is available. Record which one in `config.json` and
keep using it every week: positions from different sources do not compare.

1. **Google Search Console, free.** The best free source for a site the user
   owns, but it reports the *average position* over the period, not a
   live rank, and data lags about 2 to 3 days.
   - Through Composio, if the agent has `mcp.composio.*` tools: call
     `mcp.composio.COMPOSIO_SEARCH_TOOLS` with a use case like
     "Google Search Console search analytics query", then run what it found
     with `mcp.composio.COMPOSIO_MULTI_EXECUTE_TOOL`. Never guess the tool
     name or its arguments. Ask for the last 7 full days ending 3 days ago,
     dimension `query`, for the site property (`sc-domain:example.com` or
     the `https://` URL property). Match rows to the keyword list after
     lowercasing; a keyword with no row is `null` (not in the data).
   - If Composio is not set up but the user is signed in to Search Console
     in the agent's browser: open the Performance report for the property,
     last 7 days, Queries tab, and read the table with `browser.read_aria`.
     Never type a password or sign in for the user.
2. **The user's own paid key**, only if they already have one:
   - DataForSEO: `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` in
     `~/.atomic-agent/.env`. Run
     `rank_history.py fetch-dataforseo --domain <d> --keywords-file <path to keywords.txt> --record`
     (`--location-code`, default 2840 United States; `--language-code`,
     default `en`). Each keyword is one paid request on the user's account,
     so say how many keywords will be checked before the first run.
     `status: no_key` means the two lines are not in `.env`.
   - Ahrefs or SE Ranking MCP server, if the user connected one: look in
     the tool list for its rank tracker or organic keywords tool
     (`mcp.<server>.<tool>`), read its schema, and use it. Do not invent
     tool names.
3. **Nothing connected:** say so plainly and offer the two free options
   (connect Google Search Console through Composio, or sign in to Search
   Console in the browser). Do not make up positions.

**Never scrape Google result pages** (`google.com/search`, with the browser,
`os.web.fetch` or `os.http.request`). It breaks Google's terms, gets blocked
with a CAPTCHA, and gives personalised results that are not real ranks.

## Storing a run

```
rank_history.py record --domain example.com --source gsc --json '[{"keyword":"local ai agent","position":7.4,"url":"https://example.com/"},{"keyword":"offline agent","position":null}]'
```

`position` is a number (1 = top) or `null` when the site is not found. For a
long list write the JSON to a temp file and pass `--file`. `--date
YYYY-MM-DD` sets the run date (default today); recording the same date again
replaces that run.

## The report

`rank_history.py report --domain example.com` compares the latest run with
the one before it. Each keyword has `position`, `previous`, `change`
(positive = moved up) and `status`: `up`, `down`, `same`, `new` (now
ranking), `lost` (dropped out), `first_check`, `not_ranked`, `not_checked`.
`source_changed: true` means the two runs came from different sources, so
the change is not meaningful; say so.

Write the message short, plain text, readable on a phone:

```
example.com, week of 9 Nov (Google Search Console, avg position)
Top 10: 6 of 20 keywords. Avg position 14.2.

Up:   local ai agent 8.4 -> 5.1 (+3.3)
Down: offline agent 11 -> 15 (-4)
New:  private ai assistant -> 18
Lost: agent for mac (was 9)
No change: 12 keywords
```

List every `up`, `down`, `new` and `lost`; put the rest in one line. For
Search Console add once: "average position over 7 days".

## Weekly report to Telegram

The report reaches Telegram only if Telegram is paired with the agent
(Settings, Telegram). If it is not, tell the user the report will be skipped
until they pair it.

1. `tasks.list` first: if a task with "seo-rank-report" in its message
   already exists, do not add a second one. To change the day or time,
   `tasks.cancel { id }` the old one, then create the new one.
2. Create it with `tasks.cron`:

```
[{ "tool": "tasks.cron", "args": {
  "userMessage": "Run the seo-rank-report skill: read ~/.atomic-agent/seo-rank-report/config.json and keywords.txt, get this week's positions from the configured source, store them with rank_history.py record, run rank_history.py report and reply with the short weekly report.",
  "expression": "0 9 * * 1",
  "tz": "<the user's IANA time zone, e.g. Europe/Berlin>",
  "notify": "telegram"
} }]
```

The default is **Monday 09:00** in the user's time zone; use another day or
time if the user asks, and save it as `cron` and `tz` in `config.json`.
Each firing runs in its own session and sends its final reply to Telegram,
so the reply must be the report itself.

If `tasks.cron` is not available (agent task tools turned off), give the
user the terminal command instead:

```
atomic-agent task create --cron "0 9 * * 1" --tz Europe/Berlin --notify telegram --message "Run the seo-rank-report skill ..."
```

## Rules

- Never print `DATAFORSEO_PASSWORD` or any other key, and never put a key
  into `config.json`, a command argument or a chat message.
- A weekly run with no new data (source down, key expired) reports that in
  one line and does not store an empty run.
- Never invent or estimate a position. Unknown is `null`.
