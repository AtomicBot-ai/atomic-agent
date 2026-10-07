# Page retrieval and raw HTTP

Status: current
Owner: src/tools/os/web/

This area owns `os.web.fetch` page retrieval and `os.http.request` raw GET/POST requests. Read the inherited [tool instructions](../../AGENTS.md) and [tool contract](../../docs/contracts.md); registration stays in the [OS registry](../index.ts). [Web search](../web-search/index.ts) keeps its separate providers, cache, cooldown and transport orchestration.

## Entry points and contracts

- [web-fetch.ts](web-fetch.ts) owns curl page retrieval, redirect/retry limits and compressed results. [web-fetch-extract.ts](web-fetch-extract.ts) selects offered Markdown, Readability or basic extraction; [html-to-text.ts](html-to-text.ts) provides conversion. [web-fetch-challenge.ts](web-fetch-challenge.ts) distinguishes challenge pages from useful content. Fetch does not silently launch a browser or execute page JavaScript.
- [http-request.ts](http-request.ts) owns argument validation, configured host allowlist and approval routing. [http-request-fetch.ts](http-request-fetch.ts) owns guarded curl transport, response metadata and retry state. Raw response bodies do not go through HTML extraction.
- [web-fetch-ssrf-guard.ts](web-fetch-ssrf-guard.ts) owns HTTP URL validation, DNS/private-address checks and curl address pinning. Each redirect hop must be validated; following redirects with an unchecked curl flag would bypass this contract.
- [retry-after-header.ts](retry-after-header.ts) parses server retry hints for both request and fetch. Retry state follows the actual hop method/body: an earlier POST may already have been processed. Preserve the existing explicit invitation requirement for POST replay and the bodyless GET transition after a redirect.
- [ensure-curl.ts](ensure-curl.ts) classifies a missing curl binary and provides its error type. Web-search transport uses this helper directly; it does not acquire page-fetch or raw-request orchestration.

Callers inject command execution, DNS lookup and, where supported, sleep for deterministic tests. Request-local state owns redirect/retry progress and abortable backoff; there is no new persistent store here. Sandbox owns command processes, approval owns grants, and config owns HTTP/fetch defaults. Response bounds, abort checks, marker parsing and SSRF posture must survive mechanical moves unchanged.

## Validation

Run `npx vitest run src/tools/os/web src/tools/os/web-search/transport/search-http.test.ts` for the shared curl seam. Adjacent suites cover fetch/extraction/challenge/SSRF, HTTP policy and metadata, retry replay and abort, and Retry-After parsing. Use injected command/DNS/sleep fixtures rather than external requests. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`; catalog changes also require tool-resource-class and schema coverage.
