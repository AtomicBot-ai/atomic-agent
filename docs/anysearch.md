# AnySearch integration (maintenance)

This document describes how Atomic Agent integrates
[AnySearch](https://anysearch.com) for maintainers and bounty reviewers.

Peer patterns consulted while shaping this work: OpenClaw web-search plugin
(anonymous + vertical `tag`/`zone`/`language`), AutoGPT search/parallel/extract
blocks, CAMEL toolkit, HyperResearcher provider + concurrent batch, Hermes
vertical-search skill (discover-then-route), GPT-Researcher retriever/extract.

## What shipped

| Surface | Path | Role |
|---|---|---|
| `os.web.search` provider | `src/tools/os/web-search/providers/anysearch-provider.ts` | Anonymous/keyed general + vertical-routed search |
| Tool args | `tag` / `params` / `zone` / `language` on `os.web.search` | First-class vertical routing (other providers ignore) |
| Starter skill | `starter-skills/anysearch/` | Sub-domain discovery, parallel `batch-search.js`, extract, MCP notes |
| Config | `web.search.anysearch.{endpoint,apiKeyEnv,zone,language}` | Defaults + optional region/language |
| Docs | this file + README secrets section | Operator enablement |

## Advantages (operator-facing)

- **Anonymous access** — works without an API key at lower rate limits
- **Vertical domains** — structured search across code, finance, academic, …
- **Parallel batch** — up to 5 queries via `skill.run_script` / `batch-search.js`
- **Extract** — full-page Markdown via `/v1/extract`
- **No new cloud** — uses hosted `https://api.anysearch.com` (no self-hosting)

## Why this shape

Atomic already owns web search through the provider contract (Exa, DuckDuckGo,
Brave, SearXNG). Adding AnySearch as another provider stays merge-friendly:
same SSRF-safe `searchHttp`, fallback, cooldown, and cache stack. Extending
`os.web.search` with optional routing fields mirrors OpenClaw without a new
tool name. Discovery, true parallel batch, and extract that do not fit the
shared contract live in the auto-seeded starter skill (Hermes / HyperResearcher).

## Enable for users

1. **Select the provider** (a key alone does **not** auto-select it):

```json
{
  "web": {
    "search": {
      "provider": "anysearch",
      "fallback": ["duckduckgo"],
      "anysearch": {
        "zone": null,
        "language": null
      }
    }
  }
}
```

Or keep Exa as primary and add `"anysearch"` to `fallback`.

2. **Optional key** — `<stateDir>/.env`:

```
ANYSEARCH_API_KEY=as_sk_…
```

3. **Vertical example**

```json
{
  "tool": "os.web.search",
  "args": {
    "query": "Go context cancellation",
    "tag": "code.doc",
    "params": { "library": "golang" },
    "maxResults": 5
  }
}
```

4. **Optional MCP** — `https://api.anysearch.com/mcp` (Streamable HTTP).

## Hardening notes

- HTTP **402** quota → `WebSearchRateLimitedError` (orchestrator parks / falls back)
- Bearer tokens redacted from surfaced error strings
- Cache keys include `tag` / `params` / `zone` / `language` extras
- Authenticated calls never silently fall back to anonymous on 401

## API surface

| Method | Path | Used by |
|---|---|---|
| `POST` | `/v1/search` | Provider + skill + batch script |
| `GET` | `/v1/sub-domains` | Skill |
| `POST` | `/v1/extract` | Skill |
| `POST` | `/v1/auth/email/register` | Skill (optional) |

Client headers: `atomic-agent/web-search`, `atomic-agent/skill`,
`atomic-agent/skill-batch`.

## Tests

```sh
npx vitest run src/tools/os/web-search/providers/anysearch-provider.test.ts
npx vitest run src/tools/os/web-search/tool/warn-missing-search-key.test.ts
npx vitest run src/tools/os/web-search/providers/search-orchestrator.test.ts
```

## File map

- `src/tools/os/web-search/providers/anysearch-provider.ts`
- `src/tools/os/web-search/tool/web-search-tool.ts`
- `src/tools/os/web-search/transport/search-cache.ts` (`buildSearchCacheExtras`)
- `src/config/config-schema.ts`
- `starter-skills/anysearch/SKILL.md`
- `starter-skills/anysearch/scripts/batch-search.js`
- `docs/anysearch.md`

## Bounty checklist

- [x] Built-in provider + seeded skill + docs
- [x] General search (anonymous + keyed)
- [x] Vertical domain search (tool args + discovery)
- [x] Parallel batch (`batch-search.js`)
- [x] Extract
- [x] Markdown maintenance doc
