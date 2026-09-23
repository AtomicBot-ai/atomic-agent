# AnySearch integration (maintenance)

This document describes how Atomic Agent integrates
[AnySearch](https://anysearch.com) for maintainers and bounty reviewers.

## What shipped

| Surface | Path | Role |
|---|---|---|
| `os.web.search` provider | `src/tools/os/web-search/providers/anysearch-provider.ts` | General anonymous/keyed web search through the existing provider contract |
| Starter skill | `starter-skills/anysearch/` | Vertical domains (`tag`/`params`), batch search guidance, URL extract, optional MCP notes |
| Config | `web.search.anysearch.{endpoint,apiKeyEnv}` | Defaults to `https://api.anysearch.com/v1/search` and `ANYSEARCH_API_KEY` |

## Why this shape

Atomic Agent already owns web search through `os.web.search` (Exa, DuckDuckGo,
Brave, SearXNG). Adding AnySearch as another provider matches that contract and
stays merge-friendly: no new tool names, no SDK dependency, same SSRF-safe
`searchHttp` transport, same fallback/cooldown/cache stack.

Capabilities that do not fit the shared `{query, maxResults}` provider
interface — vertical discovery, tagged search, parallel batch, extract — live
in the auto-seeded `anysearch` starter skill and call the public REST API via
`os.http.request` (same pattern as the `notion` and `currency` starters).

## Enable for users

1. **Provider (general search)** — in `~/.atomic-agent/config.json`:

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

Or keep Exa as primary and add `"anysearch"` to `fallback`.

2. **Optional key** — append to `~/.atomic-agent/.env`:

```
ANYSEARCH_API_KEY=as_sk_…
```

Anonymous access works without a key (lower rate limits). Register at
https://anysearch.com/console/api-keys or via
`POST /v1/auth/email/register`.

3. **Vertical / extract** — on first boot the starter skill is copied to
`<stateDir>/skills/anysearch/`. The agent should `skill.view({ name: "anysearch" })`
then follow the skill body.

4. **Optional MCP** — Streamable HTTP endpoint `https://api.anysearch.com/mcp`
(documented in the skill). Not required for the integration to qualify.

## API surface used

| Method | Path | Used by |
|---|---|---|
| `POST` | `/v1/search` | Provider + skill |
| `GET` | `/v1/sub-domains` | Skill (vertical discovery) |
| `POST` | `/v1/extract` | Skill |
| `POST` | `/v1/auth/email/register` | Skill (optional key bootstrap) |

Client attribution header: `X-Anysearch-Client: atomic-agent/web-search` (provider)
or `atomic-agent/skill` (skill).

## Tests

```sh
npx vitest run src/tools/os/web-search/providers/anysearch-provider.test.ts
npx vitest run src/tools/os/web-search/tool/warn-missing-search-key.test.ts
```

Live smoke (optional, network):

```sh
curl -fsS -X POST https://api.anysearch.com/v1/search \
  -H "Content-Type: application/json" \
  -H "X-Anysearch-Client: atomic-agent/smoke" \
  -d '{"query":"hello world","max_results":1}'
```

## File map

- `src/tools/os/web-search/web-search-provider.ts` — provider name union
- `src/tools/os/web-search/providers/anysearch-provider.ts` — implementation
- `src/tools/os/web-search/providers/anysearch-provider.test.ts` — unit tests
- `src/tools/os/web-search/providers/provider-registry.ts` — wiring
- `src/tools/os/web-search/providers/search-orchestrator.ts` — keyless usability
- `src/tools/os/web-search/tool/warn-missing-search-key.ts` — optional-key warning
- `src/config/config-schema.ts` — defaults + parse
- `starter-skills/anysearch/SKILL.md` — agent playbook
- `docs/anysearch.md` — this file

## Bounty checklist

- [x] Built-in (merged into main / shipped with release starters)
- [x] General search (anonymous + keyed)
- [x] Vertical domain search (skill + `/v1/sub-domains`)
- [x] Parallel / multi-query guidance (skill)
- [x] Extract (skill + `/v1/extract`)
- [x] Markdown maintenance doc (`docs/anysearch.md`)
- [x] Users can follow official docs (`README.md` / `SKILLS.md` / this file)
