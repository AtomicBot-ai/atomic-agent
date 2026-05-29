---
name: notion
description: Read and write Notion pages, databases (data sources), and blocks via the Notion REST API.
version: 1.3.0
requires_tools:
  - os.shell.run
  - os.http.request
dangerous: false
---

# notion

Talk to the Notion API (`api.notion.com`) directly over HTTP. No SDK required.

## Calling convention (critical)

`os.http.request` is **approval-gated** in atomic-agent. Every call MUST be emitted as a **solo step** — a length-1 array, never combined with another tool in the same step:

DO — solo step, GET shape (use for `/v1/pages/{id}`, `/v1/blocks/{id}/children`, `/v1/users`):

```
[
  {
    "tool": "os.http.request",
    "args": {
      "method": "GET",
      "url": "https://api.notion.com/v1/pages/{page_id}",
      "headers": { "Authorization": "Bearer <key>", "Notion-Version": "2025-09-03" }
    }
  }
]
```

DO — solo step, POST shape (use for `/v1/search`, `/v1/pages` create, `/v1/data_sources/{id}/query`):

```
[
  {
    "tool": "os.http.request",
    "args": {
      "method": "POST",
      "url": "https://api.notion.com/v1/search",
      "headers": {
        "Authorization": "Bearer <key>",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json"
      },
      "body": { "query": "page title" }
    }
  }
]
```

DON'T — these are rejected by the runtime with `GrammarError: approval-gated tool 'os.http.request' is forbidden inside a batch`:

```
[ { "tool": "os.http.request", ... }, { "tool": "os.http.request", ... } ]   // two HTTP calls in one step
[ { "tool": "reply", ... },           { "tool": "os.http.request", ... } ]   // reply + HTTP in one step
[ { "tool": "os.http.request", ... }, { "tool": "os.shell.run",   ... } ]   // any other approval-gated peer
```

To fetch N pages, emit **N consecutive solo steps**, each as `[{...}]`. Wait for each `tool_result` before issuing the next call. Do not try to parallelise reads of the Notion API.

`args.body` for POST must be a **JSON object** (the runtime serialises it). Do **not** wrap it in quotes and escape the braces — passing `body: "{\"key\":\"val\"}"` works but is fragile and is the #1 cause of `400 invalid_json` from Notion.

## Setup check (lazy — read the key once, don't re-probe)

Read `NOTION_API_KEY` from the environment **once** when you first need it
this conversation (`printenv NOTION_API_KEY`), then reuse the value in
`Authorization: Bearer …` headers for the rest of the session. Do not
re-probe before every HTTP call. Map failures:

- the key is empty / unset (printenv exits non-zero or prints nothing) → **Setup playbook → "NOTION_API_KEY is not set"**.
- any HTTP call returns `404 object_not_found` → **Setup playbook → "Page not shared with the integration"**.

## Setup playbook (when prerequisites are missing)

When a check fails, the agent's job is to OFFER concrete help and EXECUTE the fix itself — not to dump setup instructions on the user. Use this dialogue shape:

1. State plainly what is missing (one short reply).
2. Offer the most direct remediation the agent can perform via tools.
3. Wait for the user's reply (yes/no, or pasted secret).
4. Execute the fix via tools (the runtime approval gate will surface writes for confirmation).
5. Retry the original request; only then proceed.

### NOTION_API_KEY is not set

The agent CAN write the key into `~/.atomic-agent/.env` itself once the user provides it. Offer two paths in a single reply:

> «У вас не задан `NOTION_API_KEY`. Два варианта:
> (a) Если ключ уже есть — пришлите его сюда, я допишу его в `~/.atomic-agent/.env` и попрошу перезапустить агента.
> (b) Если ключа нет — я объясню, как создать интеграцию в Notion (это занимает ~1 минуту), а в конце вы пришлёте мне ключ, и я допишу его сам.
> Что выбираете?»

#### Path (a) — user pastes the key

When the user replies with a string starting with `ntn_` or `secret_`, validate the shape (length ≥ 40, no whitespace) and append to the env file:

```
[{ "tool": "os.fs.write", "args": {
   "path": "~/.atomic-agent/.env",
   "mode": "append",
   "content": "\nNOTION_API_KEY=<pasted-key>\n"
} }]
```

Then reply: «Ключ сохранён в `~/.atomic-agent/.env`. Перезапустите агента (Ctrl+C и заново), чтобы env-переменная подхватилась — после рестарта я продолжу с того же места.» Do NOT echo the key back verbatim in subsequent replies; treat it as a secret from this point.

#### Path (b) — guided walkthrough

The agent CANNOT create Notion integrations itself (no Notion API for that — it requires browser-based OAuth-flow). Open the page for the user and walk them through the irreducible manual steps:

```
[{ "tool": "os.shell.run", "args": { "cmd": "open", "args": ["https://www.notion.so/profile/integrations"] } }]
```

Then reply with three short bullets:

> «Я открыл страницу интеграций. Сделайте три шага:
> 1. Нажмите "+ New integration", выберите "Internal", дайте любое имя, нажмите Save.
> 2. На вкладке Configuration скопируйте "Internal Integration Token" (начинается с `ntn_`).
> 3. Пришлите токен сюда — дальше я сам.»

When the user pastes the token, switch to Path (a).

### Page not shared with the integration

Notion returns `404 object_not_found` when the integration doesn't have access to a page or database. The agent CANNOT add the integration via API (Notion does not expose the connection-grant endpoint to integrations). Help the user share, but do it concretely — open the page in their browser:

```
[{ "tool": "os.shell.run", "args": { "cmd": "open", "args": ["https://www.notion.so/<page_id_without_dashes>"] } }]
```

Then reply:

> «Я открыл страницу в браузере. В правом верхнем углу нажмите `…` → `Connections` (или `Connect to`) → выберите вашу интеграцию. После этого скажите "готово" — я повторю запрос.»

## Calling the API

```
os.http.request {
  method: "GET",
  url: "https://api.notion.com/v1/...",
  headers: {
    "Authorization": "Bearer ntn_xxx_your_key_here",
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json"
  }
}
```

`os.http.request` only supports `GET` and `POST`. For `PATCH` (update page, append blocks) and `DELETE`, fall back to `os.shell.run` with `curl`:

```
os.shell.run {
  cmd: "curl",
  args: [
    "-fsSL", "-X", "PATCH",
    "-H", "Authorization: Bearer ntn_xxx_your_key_here",
    "-H", "Notion-Version: 2025-09-03",
    "-H", "Content-Type: application/json",
    "-d", "{\"properties\": {...}}",
    "https://api.notion.com/v1/pages/{page_id}"
  ]
}
```

Default `http.approvalMode` is `writes`: `GET` goes through silently, `POST`/`os.shell.run` always require approval — present a clear `preview` of what is being changed.

## Common operations

All examples assume the headers from Step 1 above are attached.

### HTTP method cheat sheet

| Method | Endpoints |
|---|---|
| `GET` | `/v1/pages/{id}`, `/v1/blocks/{id}/children`, `/v1/databases/{id}`, `/v1/data_sources/{id}`, `/v1/users`, `/v1/users/{id}` |
| `POST` | `/v1/search`, `/v1/pages` (create), `/v1/data_sources/{id}/query`, `/v1/databases` (create) |
| `PATCH` (curl) | `/v1/pages/{id}` (update properties), `/v1/blocks/{id}/children` (append blocks), `/v1/blocks/{id}` (update block) |
| `DELETE` (curl) | `/v1/blocks/{id}` (archive block) |

If a 400 comes back from Notion, **first** check that the method matches this table — picking GET for a POST endpoint is the most common mistake.

### Search (POST)

> `/v1/search` is **POST-only**. There is no GET variant — `GET /v1/search` and `GET /v1/search?query=…` both return `400`. The query string and any filters go in the **JSON body**, not the URL.

#### Body field reference (every field is optional)

| Field | Type | Allowed shape |
|---|---|---|
| `query` | string | Free-text match against page/database titles. Pass `""` or omit to list everything. |
| `filter` | object | **Exactly two keys**: `{ "property": "object", "value": "page" \| "data_source" }`. Property-predicate filters (`{property:"Status", select:{equals:"…"}}`) are **rejected** here — that shape belongs to `/v1/data_sources/{id}/query`. |
| `sort` | object **(singular, not array)** | **Exactly two keys**: `{ "direction": "ascending" \| "descending", "timestamp": "last_edited_time" }`. Array form (`[{...}]`) is **rejected** with `body.sort should be an object or undefined`. The inner key is `timestamp`, NOT `property`. The only legal value for `timestamp` is `"last_edited_time"`. Direction must be the full word — never `"asc"` / `"desc"`. |
| `page_size` | integer | `1..100`. Default `100`. |
| `start_cursor` | string | Opaque cursor from the previous response's `next_cursor`. |

#### Search vs database-query: side-by-side schema

`/v1/search` and `/v1/data_sources/{id}/query` look similar but have **different** filter and sort shapes. Don't cross-pollinate them.

| | `POST /v1/search` | `POST /v1/data_sources/{id}/query` |
|---|---|---|
| Sort key name | `sort` (singular) | `sorts` (plural) |
| Sort value shape | object `{ direction, timestamp }` | array `[ { property, direction }, … ]` |
| Sort inner key | `timestamp: "last_edited_time"` | `property: "<your-column-name>"` |
| Filter shape | `{ property: "object", value: "page"\|"data_source" }` | property-predicate, e.g. `{ property: "Status", select: { equals: "Done" } }` |

Search by query text (filter optional):

```
os.http.request {
  method: "POST",
  url: "https://api.notion.com/v1/search",
  headers: { ... },
  body: { "query": "page title" }
}
```

List all pages the integration can see, newest first, no query:

```
os.http.request {
  method: "POST",
  url: "https://api.notion.com/v1/search",
  headers: { ... },
  body: {
    "filter":    { "property": "object", "value": "page" },
    "sort":      { "direction": "descending", "timestamp": "last_edited_time" },
    "page_size": 50
  }
}
```

To page through results, send the `next_cursor` from the previous response back as `start_cursor`. To list databases instead of pages, set `filter.value` to `"data_source"`.

### Get page metadata (GET)

```
GET https://api.notion.com/v1/pages/{page_id}
```

### Get page content / blocks (GET)

```
GET https://api.notion.com/v1/blocks/{page_id}/children
```

### Create a page in a database (POST)

```
os.http.request {
  method: "POST",
  url: "https://api.notion.com/v1/pages",
  headers: { ... },
  body: {
    "parent": { "database_id": "xxx" },
    "properties": {
      "Name":   { "title":  [ { "text": { "content": "New Item" } } ] },
      "Status": { "select": { "name": "Todo" } }
    }
  }
}
```

### Query a database / data source (POST)

```
os.http.request {
  method: "POST",
  url: "https://api.notion.com/v1/data_sources/{data_source_id}/query",
  headers: { ... },
  body: {
    "filter": { "property": "Status", "select": { "equals": "Active" } },
    "sorts":  [ { "property": "Date", "direction": "descending" } ]
  }
}
```

### Update page properties (PATCH — via curl)

```
os.shell.run {
  cmd: "curl",
  args: [
    "-fsSL", "-X", "PATCH",
    "-H", "Authorization: Bearer <key>",
    "-H", "Notion-Version: 2025-09-03",
    "-H", "Content-Type: application/json",
    "-d", "{\"properties\":{\"Status\":{\"select\":{\"name\":\"Done\"}}}}",
    "https://api.notion.com/v1/pages/{page_id}"
  ]
}
```

### Append blocks to a page (PATCH — via curl)

Same shape as above but URL is `https://api.notion.com/v1/blocks/{page_id}/children` and the body is:

```
{ "children": [ { "object": "block", "type": "paragraph",
                   "paragraph": { "rich_text": [ { "text": { "content": "Hello" } } ] } } ] }
```

## Property types (cheat sheet)

- Title: `{ "title": [ { "text": { "content": "..." } } ] }`
- Rich text: `{ "rich_text": [ { "text": { "content": "..." } } ] }`
- Select: `{ "select": { "name": "Option" } }`
- Multi-select: `{ "multi_select": [ { "name": "A" }, { "name": "B" } ] }`
- Date: `{ "date": { "start": "2026-01-15", "end": "2026-01-16" } }`
- Checkbox: `{ "checkbox": true }`
- Number: `{ "number": 42 }`
- URL: `{ "url": "https://..." }`
- Email: `{ "email": "user@example.com" }`
- Relation: `{ "relation": [ { "id": "page_id" } ] }`

## API version 2025-09-03 — what changed

- "Databases" are now called **data sources** in the API surface.
- Each database carries both a `database_id` (used as `parent` when creating pages) and a `data_source_id` (used as the path component when querying: `POST /v1/data_sources/{id}/query`).
- Search results for databases come back as `"object": "data_source"` with their `data_source_id`.

## Notes

- Page and database IDs are UUIDs; both with and without dashes are accepted.
- Rate limit: ~3 requests/second average. Back off on `429`.
- The API cannot set database view filters — that is a UI-only feature.
- If the agent gets `object_not_found` (404), the most common cause is forgetting to share the page with the integration.
- Never echo the `Authorization` header value back to the user verbatim. Treat the key as a secret.
- `/v1/search` and `/v1/data_sources/{id}/query` use **different** filter shapes. `/v1/search` only filters by object type (`{property:"object", value:"page"|"data_source"}`); the property-predicate filter (`{property:"Status", select:{equals:"Active"}}`) belongs exclusively to `/v1/data_sources/{id}/query`.
- To fetch multiple pages or blocks, emit one solo `os.http.request` step at a time and wait for each result. The runtime forbids batching approval-gated tools (see `## Calling convention`).
- `GET /v1/pages/{id}` returns the full property map by default. Do **not** append `?include=properties` or any similar query param — Notion does not define one and will silently ignore it.

## Troubleshooting — common 400 patterns

When Notion returns `400 validation_error`, the message text is precise — read it before retrying. The three most common patterns seen in agent traces:

### `body.sort should be an object or undefined, instead was [{…}]`

You sent `sort` as an array. `/v1/search` accepts only the singular-object form:

DO:
```
"sort": { "direction": "descending", "timestamp": "last_edited_time" }
```

DON'T (taken from a real failing trace):
```
"sort": [ { "property": "last_edited_time", "direction": "descending" } ]   // wrong: array, plural-style
"sort": [ { "property": "last_edited_time", "direction": "desc" } ]         // wrong: array AND short direction
```

The array-of-`{property, direction}` form belongs to `/v1/data_sources/{id}/query` under the key `sorts` (plural). See the side-by-side table in `### Search (POST)`.

### `body.filter.property should be "object", instead was "<something>"`

You sent a property-predicate filter to `/v1/search`. That endpoint only accepts an object-type filter:

DO:
```
"filter": { "property": "object", "value": "page" }
"filter": { "property": "object", "value": "data_source" }
```

DON'T:
```
"filter": { "property": "Status", "select": { "equals": "Done" } }     // wrong endpoint
"filter": { "property": "name",   "text":   { "contains": "" } }       // invented, not a Notion shape
"filter": { "property": "parent", "database_id": null, "rich_text": { "exists": true } }  // frankenstein
```

If you actually need to filter by page properties, switch to `POST /v1/data_sources/{id}/query` and use the property-predicate shape there.
