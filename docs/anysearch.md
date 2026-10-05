# AnySearch (opt-in web search provider)

[AnySearch](https://anysearch.com) is an **opt-in** `os.web.search` provider.
It is **off by default**. Default installs keep Exa (+ DuckDuckGo fallback);
nothing in the shared tool catalog, result format, or starter-skill seed
changes until you select AnySearch.

## Third-party disclosure

When `web.search.provider` is `"anysearch"` (or AnySearch is listed in
`web.search.fallback`), search queries are sent to the **hosted third-party
API** at `https://api.anysearch.com`. Atomic Agent does not self-host
AnySearch. Review AnySearch’s terms and privacy policy before enabling it.

## Enable

```json
{
  "web": {
    "search": {
      "provider": "anysearch",
      "fallback": ["duckduckgo"]
    }
  }
}
```

A key alone does **not** select the provider. Optional higher limits:

```
ANYSEARCH_API_KEY=as_sk_…
```

Optional region / language defaults (config only):

```json
{
  "web": {
    "search": {
      "provider": "anysearch",
      "anysearch": {
        "zone": "intl",
        "language": "en"
      }
    }
  }
}
```

## Behaviour

| Topic | Detail |
|---|---|
| Transport | Existing SSRF-safe `searchHttp`, orchestrator fallback / cache / cooldown |
| Auth | Anonymous by default; Bearer when `ANYSEARCH_API_KEY` is set |
| Quota | HTTP 402 parks like a rate limit and advances the fallback chain |
| Client header | `X-Anysearch-Client: atomic-agent/web-search@<version>` |

## Code map

| Path | Role |
|---|---|
| `src/tools/os/web-search/providers/anysearch-provider.ts` | Provider |
| `src/config/web-config.ts` | `web.search.anysearch.*` |
| `src/tools/os/web-search/providers/provider-registry.ts` | Registry entry |
