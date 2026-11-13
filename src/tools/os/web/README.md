# Page retrieval and raw HTTP

Status: current
Owner: src/tools/os/web/

This area owns `os.web.fetch` page retrieval, `os.web.crawl` multi-page reads and `os.http.request` raw GET/POST requests. Read the inherited [tool instructions](../../AGENTS.md) and [tool contract](../../docs/contracts.md); registration stays in the [OS registry](../index.ts). [Web search](../web-search/index.ts) keeps its separate providers, cache, cooldown and transport orchestration.

## Entry points and contracts

- [web-fetch.ts](web-fetch.ts) owns curl page retrieval, redirect/retry limits and compressed results. [web-fetch-extract.ts](web-fetch-extract.ts) selects offered Markdown, Readability or basic extraction (with `web.fetch.extractor: "defuddle"`, Defuddle runs before Readability, offline: its third-party fetches are disabled; ATO-698); [html-to-text.ts](html-to-text.ts) provides conversion. [web-fetch-challenge.ts](web-fetch-challenge.ts) distinguishes challenge pages from useful content. Fetch runs no page JavaScript itself; only after a bot wall does it go down the page-read ladder below.
- [http-request.ts](http-request.ts) owns argument validation, configured host allowlist and approval routing. [http-request-fetch.ts](http-request-fetch.ts) owns guarded curl transport, response metadata and retry state. [http-request-preview.ts](http-request-preview.ts) builds the masked text the approval prompt shows. Raw response bodies do not go through HTML extraction.
- [web-fetch-ssrf-guard.ts](web-fetch-ssrf-guard.ts) owns HTTP URL validation, DNS/private-address checks and curl address pinning. Each redirect hop must be validated; following redirects with an unchecked curl flag would bypass this contract.
- [retry-after-header.ts](retry-after-header.ts) parses server retry hints for both request and fetch. Retry state follows the actual hop method/body: an earlier POST may already have been processed. Preserve the existing explicit invitation requirement for POST replay and the bodyless GET transition after a redirect.
- [web-crawl.ts](web-crawl.ts) owns `os.web.crawl` (ATO-700): [the loop](web-crawl-run.ts) reads the start page, its same-origin links breadth first up to `maxDepth`, and the sitemap ([links and sitemaps](crawl-links.ts)); [arguments and report](web-crawl-args.ts) hold the caps. Every request goes through `fetchRawPage` in web-fetch.ts, so the SSRF guard, redirect re-validation and retry rules are the fetch tool's own; extraction is `extractWebContent`.
- [crawl-politeness.ts](crawl-politeness.ts) is the politeness layer (ATO-970): one request per host per `web.crawl.minDelayMs` (a longer robots.txt `Crawl-delay` wins, capped at 30 s), a pause after 429/503 that honours `Retry-After` (capped at 60 s), a stop after three pages in a row still answer 429/503 after their retries (counted per crawl), robots.txt per origin ([parser](robots-txt.ts), RFC 9309: 4xx means no rules, 5xx or no answer means stay out) with `web.crawl.robotsExemptHosts` for the user's own sites, and a TTL cache of pages and robots.txt. The pace is held through `fetchRawPage`'s `hooks`, which fire on every attempt and redirect hop; `allowRedirect` checks each same-site redirect hop against robots.txt before it is requested.
- [ensure-curl.ts](ensure-curl.ts) classifies a missing curl binary and provides its error type. Web-search transport uses this helper directly; it does not acquire page-fetch or raw-request orchestration.

## Page-read ladder (ATO-968)

[web-fetch-ladder.ts](web-fetch-ladder.ts) runs only when curl got a challenge page. Each step is tried in order and the first one that returns a real page wins; `details.readVia` (`curl` | `browser` | `jina` | `firecrawl`) names it and the page text opens with one line saying how it was read. When none gets through, the wall error stays and lists what was tried (`details.ladderAttempts`).

1. `curl` + extraction, as always.
2. `browser`: the page is rendered in a throwaway tab of the agent's own browser (`web.fetch.renderWithBrowser`, default on; needs `browser.enabled`). Never the user's own Chrome (`browser.connect: "user-chrome"`). `browser.blockedDomains` and `browser.allowedDomains` apply before and after the load, and the page it landed on must pass the same private-address check as every curl hop. The tab is never the model's active page.
3. Readers that render on their own servers, so the URL leaves the machine: [web-fetch-readers.ts](web-fetch-readers.ts). Jina Reader runs when `web.fetch.jinaReader` is on (keyless, rate-limited) or a key is in `web.fetch.jinaApiKeyEnv`; Firecrawl when a key is in `web.fetch.firecrawlApiKeyEnv`. Both are off by default. Keys go to curl in a header file, never on the command line.

## Approval and credentials (ATO-1182, ATO-1471)

- "Allow for this session" on an `os.http.request` prompt covers the target's origin (scheme, host, port) only: the request carries `grantKey` and the gate keys the grant by it. A POST to another host asks again.
- A redirect that would carry the method and body to another origin (a 307/308 after a POST) is not followed. The result names the `Location` (`details.redirectNotFollowed`) and the model has to make a new request there, which is gated like any other. Same-origin redirects and bodyless GET hops are still followed.
- Any hop on another origin is sent without credential headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key` and any name containing token, secret, key, auth, password, session, cookie, credential or signature).
- The approval preview masks the values of those headers (`Authorization: Bearer ****`), since it is shown in the terminal, the desktop app and Telegram.
- The prompt's URL (preview, reason and `affectedResources`) masks query and fragment values whose name says secret (`api_key`, `token`, `key`, `access_token`, `sig`, `signature`, `password`, `code`, ...) and any value the shared detector (`src/error-reporting/secret-detector.ts`) flags, plus a password in the authority. The body preview masks JSON fields and form fields by name, and runs the detector over any body. Masking happens before the body is cut to 400 characters. Only the prompt is masked; the request goes out as given.
- "Allow always" on an HTTP prompt saves a rule with `origin` set to the request's origin, so it covers that one host (and port and scheme), not every host. A request with no origin cannot be saved for always.
- Known limitation: with the default `http.approvalMode: "writes"` a GET runs without a prompt, and a GET can still carry data out in its URL (query string, path) and headers. Use `approvalMode: "always"` or `http.hostAllowlist` where that matters. With `agent.taintReview` on, a GET (and every `os.web.fetch`) on a session that read outside content this turn goes to the approval gate anyway, as an `http` request the taint hold settles (ATO-618); `approvalMode: "never"` and a set `hostAllowlist` keep answering for `os.http.request`.

Callers inject command execution, DNS lookup and, where supported, sleep for deterministic tests. Request-local state owns redirect/retry progress and abortable backoff; there is no new persistent store here. Sandbox owns command processes, approval owns grants, and config owns HTTP/fetch defaults. Response bounds, abort checks, marker parsing and SSRF posture must survive mechanical moves unchanged.

## Validation

Run `npx vitest run src/tools/os/web src/tools/os/web-search/transport/search-http.test.ts` for the shared curl seam. Adjacent suites cover fetch/extraction/challenge/SSRF, HTTP policy and metadata, retry replay and abort, and Retry-After parsing. Use injected command/DNS/sleep fixtures rather than external requests. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`; catalog changes also require tool-resource-class and schema coverage.
