---
name: monid
description: Live web data through Monid (monid.ai), one key for 3,100+ paid tools - X and Reddit posts, leads, company and funding data, SEO, screenshots, video. Use when the user mentions Monid. Runs cost money; state the price first.
version: 1.0.0
requires_tools:
  - os.shell.run
dangerous: true
---

# monid

Monid is a pay-per-call gateway to live data tools. Call its HTTP API with `curl` through `os.shell.run`.

**Use `os.shell.run` for every call. Do not use `os.http.request`:** it cannot read `$MONID_API_KEY`, so it always gets 401. Only the shell expands the variable. Never print the key or echo the `Authorization` header.

The flow is always **discover → inspect → run**. Discover and inspect are free; run is billed from the user's Monid wallet.

## Setup check (lazy: only when a call fails)

Do not probe before every request. Run the call; react to the result:

- **401, or `$MONID_API_KEY` is empty** (`[ -n "$MONID_API_KEY" ] && echo set || echo missing`):
  - Tell the user: "Create a key at https://app.monid.ai/access/api-keys, add `MONID_API_KEY=monid_live_...` to `~/.atomic-agent/.env`, then restart Atomic Agent." Do not ask them to paste the key into the chat.
  - If they say the key is already in `.env` but the shell still sees nothing, their `config.json` was written before Monid was a default: add `"MONID_API_KEY"` to `tools.shell.envPassthrough` in `~/.atomic-agent/config.json` and restart.
- **402**: the wallet is empty. Tell the user to top up at https://app.monid.ai and stop.

## JSON bodies

Never inline JSON in `-d '...'` (quotes break). Write the body to a file with a quoted heredoc, then send it with `-d @file`:

```bash
cat > /tmp/monid_body.json <<'JSON'
{"provider":"anyapi","endpoint":"/twitter.search","input":{"body":{"route":"lynx","query":"\"local AI\" agent lang:en -filter:replies","queryType":"Top","limit":20}}}
JSON
curl -s -X POST https://api.monid.ai/v1/run -H "Authorization: Bearer $MONID_API_KEY" -H "Content-Type: application/json" -d @/tmp/monid_body.json
```

## 1. Discover (free)

```bash
curl -s -X POST https://api.monid.ai/v1/discover/endpoints \
  -H "Authorization: Bearer $MONID_API_KEY" -H "Content-Type: application/json" \
  -d '{"q":"twitter posts by keyword","limit":5}'
```

Pick the best card by relevance and health. Note its `provider` and `endpoint`.

Known-good tools (tested):

| Need | provider / endpoint | Example input | Price |
|---|---|---|---|
| X posts | `anyapi` `/twitter.search` (async) | `{"body":{"route":"lynx","query":"...","queryType":"Top","limit":20}}` | ~$0.0005 per search |
| Reddit posts | `anyapi` `/reddit.search` | `{"body":{"query":"linear.app OR \"linear vs jira\"","sort":"relevance","timeframe":"year"}}` | ~$0.0004 |
| Company + funding | `fundable` `/company` | `{"queryParams":{"domain":"linear.app"}}` | $0.06 |
| Founder / people leads | `contactout` `/v1/people/search/work-email` | `{"body":{"job_title":["Founder OR Co-Founder OR CEO"],"seniority":["Owner / Founder"],"location":["San Francisco, California, United States"],"data_types":["work_email"],"page_size":5,"reveal_info":false}}` | $0.02 per profile |
| Keywords a site ranks for | `dataforseo` `/labs/ranked-keywords` | `{"body":{"target":"example.com","location_code":2840,"language_code":"en","limit":50}}` | $0.012 + $0.00012 per keyword |
| What ChatGPT says | `dataforseo` `/ai/chatgpt-response` | `{"body":{"user_prompt":"What is Linear?","model_name":"gpt-4o-mini","max_output_tokens":300}}` | ~$0.0007 |
| Page screenshot | `anyapi` `/web.screenshot` | `{"body":{"url":"https://linear.app/pricing","viewportWidth":1280}}` | ~$0.0013 |
| Video from an image | `heygen` `/v1/video/heygen-video-1-i2v` (async) | `{"body":{"prompt":"...","image":{"type":"url","url":"https://..."},"resolution":"768p","duration":5}}` | $0.036 per second |

Notes:
- Avoid `twitterdata.io` `/tweets/search`: it returns empty results.
- Reddit results are in `output.data.posts`. Bare common words return unrelated posts, so quote or OR specific phrases.
- ContactOut: keep `reveal_info` false unless the user asks for emails; revealing adds about $0.10 per email found.
- Crunchbase tools share a daily cap and often return 429; use `fundable` for funding.

## 2. Inspect (free: input schema + price)

```bash
curl -s -X POST https://api.monid.ai/v1/inspect \
  -H "Authorization: Bearer $MONID_API_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"PROVIDER","endpoint":"/ENDPOINT"}'
```

Tell the user the tool and its price before running. Keep inputs small (10 to 20 results) unless the user asks for more. If one request would cost more than $0.50 in total, ask before running it.

Input fields always sit inside `body` or `queryParams`, exactly as the inspect schema shows.

## 3. Run (billed)

```bash
curl -s -X POST https://api.monid.ai/v1/run \
  -H "Authorization: Bearer $MONID_API_KEY" -H "Content-Type: application/json" \
  -d @/tmp/monid_body.json
```

- **200** with the full run: done, read `output`.
- **202**: async. Poll every 10 s with `curl -s https://api.monid.ai/v1/runs/RUN_ID -H "Authorization: Bearer $MONID_API_KEY"` until the status is final.
- status **`BLOCKED`**: a budget or run cap stopped it. Tell the user; don't retry.
- **400** `VALIDATION_FAILED`: re-read the inspect `inputSchema`, fix the field names, try once more.
- **401** / **402**: see Setup check.

## Never invent results

- Never call `reply` in the same step as `/v1/run`. Wait for the run's output first.
- Report only data that is in the run's `output`. If the run returned an error, say exactly that and stop.
- Say which facts are a provider's claims (valuations, revenue, customer counts) rather than verified.

## Finish

Give the result as a clean table or list, then one line per run: the Monid tool used and what it cost (from the run's `cost`), plus the total.
