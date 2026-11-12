/**
 * Built-in MCP server catalog (ATO-1131, ATO-1133). Data only: types,
 * validation and helpers live in `mcp-catalog.ts`.
 *
 * Every entry was checked against its official README or npm page on
 * 2026-11-12: package name, command, URL, the env var or header that
 * carries the key and where the key comes from. Servers that sign in
 * only through OAuth are left out: `mcp.servers` has no OAuth flow yet.
 * Add an entry only with the same check; never guess a package name.
 *
 * `server` uses the Claude Desktop / Cursor shortcut shape (`command` +
 * `args` + `env`, or `url` + `headers`) that `parseAddServerJson`
 * already accepts. Each `<your ...>` text inside it is a value the user
 * fills in; it must be listed in `inputs` (the schema test pins that).
 *
 * The object literal between the two markers is strict JSON on
 * purpose: the desktop keeps a copy in `desktop/renderer/mcp-catalog.js`
 * and its test parses this block to catch drift.
 */
import type { McpCatalogData } from "./mcp-catalog-types.js";

export const MCP_CATALOG_DATA: McpCatalogData =
/* catalog-json-start */
{
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
}
/* catalog-json-end */
;
