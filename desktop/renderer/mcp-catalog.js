/* ATO-1131 / ATO-1133: the built-in MCP server catalog in the Add MCP server box.

   A COPY of the data in src/mcp/mcp-catalog-data.ts (the agent and the
   terminal app read that one). The renderer is plain scripts with no build
   step that could read the agent's TypeScript, so the data is repeated
   here; test/mcp-catalog.test.mjs compares the two whenever src/ is in the
   same checkout. Change both together.

   A pick only fills the box with the server's config (the same text a user
   could paste), so mcpAddSubmit and mcp-smart-add.js stay the only write
   path. Values the user must supply are <your ...> placeholders; a submit
   that still holds one is refused.

   Loaded before renderer.js and required by the Node checks. Pure: no DOM,
   no IPC, no config access. */

const MCP_CATALOG = {
  "shelves": [
    { "id": "basics", "label": "Basics" },
    { "id": "dev", "label": "Code & docs" },
    { "id": "apps", "label": "Work apps" },
    { "id": "web-growth", "label": "Web & growth" }
  ],
  "entries": [
    {
      "id": "filesystem",
      "title": "Filesystem",
      "description": "Read, write and search files in the folders you allow.",
      "shelf": "basics",
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "<your folder path>"]
      },
      "inputs": [
        { "placeholder": "<your folder path>", "label": "Full path of the folder it may use", "secret": false }
      ]
    },
    {
      "id": "git",
      "title": "Git",
      "description": "Read, search and change a local Git repository.",
      "shelf": "basics",
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
      "requires": "uv",
      "server": {
        "command": "uvx",
        "args": ["mcp-server-git", "--repository", "<your repository path>"]
      },
      "inputs": [
        { "placeholder": "<your repository path>", "label": "Full path of the repository", "secret": false }
      ]
    },
    {
      "id": "fetch",
      "title": "Fetch",
      "description": "Fetch a web page and turn it into Markdown.",
      "shelf": "basics",
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
      "requires": "uv",
      "server": { "command": "uvx", "args": ["mcp-server-fetch"] },
      "inputs": []
    },
    {
      "id": "time",
      "title": "Time",
      "description": "Current time and time zone conversion.",
      "shelf": "basics",
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
      "requires": "uv",
      "server": { "command": "uvx", "args": ["mcp-server-time"] },
      "inputs": []
    },
    {
      "id": "memory",
      "title": "Memory graph",
      "description": "A small knowledge graph the model can write to and read back.",
      "shelf": "basics",
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
      "requires": "node",
      "server": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
      "inputs": []
    },
    {
      "id": "sequential-thinking",
      "title": "Sequential thinking",
      "description": "Step-by-step problem solving with revisable thoughts.",
      "shelf": "basics",
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
      "requires": "node",
      "server": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
      "inputs": []
    },
    {
      "id": "github",
      "title": "GitHub",
      "description": "Repositories, issues and pull requests through GitHub's hosted server.",
      "shelf": "dev",
      "homepage": "https://github.com/github/github-mcp-server",
      "server": {
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": { "Authorization": "Bearer <your GitHub token>" }
      },
      "inputs": [
        {
          "placeholder": "<your GitHub token>",
          "label": "GitHub personal access token",
          "secret": true,
          "getUrl": "https://github.com/settings/personal-access-tokens/new"
        }
      ]
    },
    {
      "id": "playwright",
      "title": "Playwright browser",
      "description": "Drive a local browser: open pages, click, type, read the page.",
      "shelf": "dev",
      "homepage": "https://github.com/microsoft/playwright-mcp",
      "requires": "node",
      "server": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
      "inputs": []
    },
    {
      "id": "context7",
      "title": "Context7",
      "description": "Up-to-date library and framework docs for coding questions.",
      "shelf": "dev",
      "homepage": "https://github.com/upstash/context7",
      "server": { "url": "https://mcp.context7.com/mcp" },
      "inputs": [],
      "note": "Works without a key; a free key from context7.com raises the rate limit."
    },
    {
      "id": "deepwiki",
      "title": "DeepWiki",
      "description": "Ask questions about public GitHub repositories.",
      "shelf": "dev",
      "homepage": "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
      "server": { "url": "https://mcp.deepwiki.com/mcp" },
      "inputs": []
    },
    {
      "id": "notion",
      "title": "Notion",
      "description": "Search, read and edit pages in a Notion workspace.",
      "shelf": "apps",
      "homepage": "https://github.com/makenotion/notion-mcp-server",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "@notionhq/notion-mcp-server"],
        "env": { "NOTION_TOKEN": "<your Notion token>" }
      },
      "inputs": [
        {
          "placeholder": "<your Notion token>",
          "label": "Notion integration token",
          "secret": true,
          "getUrl": "https://www.notion.so/profile/integrations"
        }
      ]
    },
    {
      "id": "exa",
      "title": "Exa",
      "description": "Web search and page fetching built for AI agents.",
      "shelf": "web-growth",
      "homepage": "https://github.com/exa-labs/exa-mcp-server",
      "server": { "url": "https://mcp.exa.ai/mcp" },
      "inputs": [],
      "note": "Search and fetch work without a key on the hosted server."
    },
    {
      "id": "firecrawl",
      "title": "Firecrawl",
      "description": "Scrape, crawl, map and search websites into clean Markdown.",
      "shelf": "web-growth",
      "homepage": "https://github.com/firecrawl/firecrawl-mcp-server",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env": { "FIRECRAWL_API_KEY": "<your Firecrawl API key>" }
      },
      "inputs": [
        {
          "placeholder": "<your Firecrawl API key>",
          "label": "Firecrawl API key",
          "secret": true,
          "getUrl": "https://www.firecrawl.dev/app/api-keys"
        }
      ]
    },
    {
      "id": "apify",
      "title": "Apify",
      "description": "Run ready-made scrapers from Apify Store: maps, social, shops, search.",
      "shelf": "web-growth",
      "homepage": "https://github.com/apify/apify-mcp-server",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "@apify/actors-mcp-server"],
        "env": { "APIFY_TOKEN": "<your Apify token>" }
      },
      "inputs": [
        {
          "placeholder": "<your Apify token>",
          "label": "Apify API token",
          "secret": true,
          "getUrl": "https://docs.apify.com/integrations/api#api-token"
        }
      ]
    },
    {
      "id": "brightdata",
      "title": "Bright Data",
      "description": "Search results, page scraping past bot checks, and structured data from big sites.",
      "shelf": "web-growth",
      "homepage": "https://github.com/brightdata/brightdata-mcp",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "@brightdata/mcp"],
        "env": { "API_TOKEN": "<your Bright Data API token>" }
      },
      "inputs": [
        {
          "placeholder": "<your Bright Data API token>",
          "label": "Bright Data API token",
          "secret": true,
          "getUrl": "https://brightdata.com/cp/setting/users"
        }
      ],
      "note": "Free tier: 5,000 requests a month (per Bright Data's README)."
    },
    {
      "id": "tavily",
      "title": "Tavily",
      "description": "Real-time web search, page extraction, site map and crawl.",
      "shelf": "web-growth",
      "homepage": "https://github.com/tavily-ai/tavily-mcp",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "tavily-mcp@latest"],
        "env": { "TAVILY_API_KEY": "<your Tavily API key>" }
      },
      "inputs": [
        {
          "placeholder": "<your Tavily API key>",
          "label": "Tavily API key",
          "secret": true,
          "getUrl": "https://app.tavily.com/home"
        }
      ],
      "note": "Free account available."
    },
    {
      "id": "brave-search",
      "title": "Brave Search",
      "description": "Web, news, image and local search through the Brave Search API.",
      "shelf": "web-growth",
      "homepage": "https://github.com/brave/brave-search-mcp-server",
      "requires": "node",
      "server": {
        "command": "npx",
        "args": ["-y", "@brave/brave-search-mcp-server"],
        "env": { "BRAVE_API_KEY": "<your Brave Search API key>" }
      },
      "inputs": [
        {
          "placeholder": "<your Brave Search API key>",
          "label": "Brave Search API key",
          "secret": true,
          "getUrl": "https://api-dashboard.search.brave.com/app/keys"
        }
      ]
    }
  ]
};

const MCP_CATALOG_PLACEHOLDER_RE = /<your [^<>"]+>/g;

/* Entries grouped by shelf, in shelf order. */
function mcpCatalogList() {
  const out = [];
  for (const shelf of MCP_CATALOG.shelves) for (const e of MCP_CATALOG.entries) if (e.shelf === shelf.id) out.push(e);
  return out;
}
function mcpCatalogEntry(id) {
  return MCP_CATALOG.entries.find((e) => e.id === id) || null;
}
/* The text a pick puts in the box: the mcpServers envelope, laid out the way a README shows it. */
function mcpCatalogJson(id) {
  const e = mcpCatalogEntry(id);
  return e ? JSON.stringify({mcpServers:{[e.id]:e.server}}, null, 2) : null;
}
function mcpCatalogPlaceholders(text) {
  return [...new Set(String(text || '').match(MCP_CATALOG_PLACEHOLDER_RE) || [])];
}
/* The error for a submit that still holds a placeholder, else null. */
function mcpCatalogUnfilled(text) {
  const left = mcpCatalogPlaceholders(text);
  return left.length ? 'Replace ' + left.join(', ') + ' with your own value first.' : null;
}

/* The catalog block above the box: one chip per server, grouped by shelf, and
   for the picked one what to replace and where each key comes from. Links
   carry data-url, which the renderer's click handler opens in the browser. */
function mcpCatalogHTML(m, h) {
  const picked = m && m.catalogId ? mcpCatalogEntry(m.catalogId) : null;
  let html = '<div class="sd-catalog"><p class="tk-help">Pick a server, or paste your own config below.</p>';
  for (const shelf of MCP_CATALOG.shelves) {
    const items = MCP_CATALOG.entries.filter((e) => e.shelf === shelf.id);
    if (!items.length) continue;
    html += '<div class="tk-bar"><span class="sd-cap">' + h.esc(shelf.label) + '</span>'
      + items.map((e) => '<button class="tk-chip tk-chip--sm' + (picked && picked.id === e.id ? ' tk-chip--blue' : ' tk-chip--line')
        + '" data-act="mcp:catalog:' + h.esc(e.id) + '" title="' + h.esc(e.description) + '">' + h.esc(e.title) + '</button>').join('')
      + '</div>';
  }
  if (picked) {
    html += '<p class="tk-help">' + h.esc(picked.description) + (picked.note ? ' ' + h.esc(picked.note) : '')
      + ' <a href="#" data-url="' + h.esc(picked.homepage) + '">About</a></p>';
    for (const i of picked.inputs) {
      html += '<p class="tk-help">Replace <code>' + h.esc(i.placeholder) + '</code>: ' + h.esc(i.label)
        + (i.getUrl ? ' (<a href="#" data-url="' + h.esc(i.getUrl) + '">get it here</a>)' : '') + '</p>';
    }
  }
  return html + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {MCP_CATALOG, mcpCatalogList, mcpCatalogEntry, mcpCatalogJson, mcpCatalogPlaceholders, mcpCatalogUnfilled, mcpCatalogHTML};
}
