import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAddServerJson } from "../config/mcp-server-commands.js";
import {
  buildMcpCatalogJson,
  describeUnfilledPlaceholders,
  findCatalogPlaceholders,
  findMcpCatalogEntry,
  listMcpCatalog,
  validateMcpCatalog,
  type McpCatalogData,
  type McpCatalogEntry,
} from "./mcp-catalog.js";
import { MCP_CATALOG_DATA } from "./mcp-catalog-data.js";

function fill(entry: McpCatalogEntry): string {
  let json = buildMcpCatalogJson(entry);
  for (const input of entry.inputs) {
    json = json.split(input.placeholder).join(input.secret ? "test-key-123" : "/tmp/x");
  }
  return json;
}

function minimal(over: Partial<McpCatalogEntry> = {}): McpCatalogData {
  return {
    shelves: [{ id: "basics", label: "Basics" }],
    entries: [
      {
        id: "demo",
        title: "Demo",
        description: "A demo server.",
        shelf: "basics",
        homepage: "https://example.com/demo",
        server: { command: "npx", args: ["-y", "demo"] },
        inputs: [],
        ...over,
      },
    ],
  };
}

describe("built-in MCP catalog data", () => {
  it("passes the schema check", () => {
    expect(validateMcpCatalog(MCP_CATALOG_DATA)).toEqual([]);
  });

  it("has unique ids and every entry on a known shelf", () => {
    const ids = MCP_CATALOG_DATA.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const shelves = new Set(MCP_CATALOG_DATA.shelves.map((s) => s.id));
    for (const e of MCP_CATALOG_DATA.entries) expect(shelves.has(e.shelf)).toBe(true);
    expect(listMcpCatalog()).toHaveLength(MCP_CATALOG_DATA.entries.length);
  });

  it("every entry, once filled in, goes through the normal add parser under its id", () => {
    for (const entry of MCP_CATALOG_DATA.entries) {
      const json = fill(entry);
      expect(findCatalogPlaceholders(json)).toEqual([]);
      const server = parseAddServerJson(json);
      expect(server.name).toBe(entry.id);
      expect(server.transport.kind).toBe(
        entry.server.command !== undefined ? "stdio" : "streamable_http",
      );
    }
  });

  it("an unfilled entry is reported by its placeholders", () => {
    const firecrawl = findMcpCatalogEntry("firecrawl");
    expect(firecrawl).toBeDefined();
    const json = buildMcpCatalogJson(firecrawl!);
    expect(findCatalogPlaceholders(json)).toEqual(["<your Firecrawl API key>"]);
    expect(describeUnfilledPlaceholders(json)).toContain("<your Firecrawl API key>");
    expect(describeUnfilledPlaceholders(fill(firecrawl!))).toBeNull();
  });

  it("carries the Web & growth shelf (ATO-1133)", () => {
    const web = listMcpCatalog().filter((e) => e.shelf === "web-growth").map((e) => e.id);
    expect(web).toEqual(["exa", "firecrawl", "apify", "brightdata", "tavily", "brave-search"]);
  });

  it("lists entries grouped in shelf order", () => {
    const order = MCP_CATALOG_DATA.shelves.map((s) => s.id);
    const shelfIndex = listMcpCatalog().map((e) => order.indexOf(e.shelf));
    expect([...shelfIndex].sort((a, b) => a - b)).toEqual(shelfIndex);
  });

  it("keeps the data block strict JSON for the desktop copy", () => {
    const src = readFileSync(new URL("./mcp-catalog-data.ts", import.meta.url), "utf8");
    const start = src.indexOf("/* catalog-json-start */");
    const end = src.indexOf("/* catalog-json-end */");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const parsed = JSON.parse(src.slice(start + "/* catalog-json-start */".length, end));
    expect(parsed).toEqual(MCP_CATALOG_DATA);
  });
});

describe("validateMcpCatalog", () => {
  it("accepts a minimal entry", () => {
    expect(validateMcpCatalog(minimal())).toEqual([]);
  });

  it("rejects duplicate ids and bad names", () => {
    const data = minimal();
    data.entries.push({ ...data.entries[0]! });
    data.entries.push({ ...data.entries[0]!, id: "Bad_Name" });
    const problems = validateMcpCatalog(data);
    expect(problems).toContain("entry demo: duplicate id");
    expect(problems.some((p) => p.startsWith("entry Bad_Name: id must match"))).toBe(true);
  });

  it("rejects unknown shelves, non-https links and empty text", () => {
    const problems = validateMcpCatalog(
      minimal({ shelf: "nope" as never, homepage: "http://x.test", title: " ", description: "" }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "entry demo: unknown shelf nope",
        "entry demo: homepage must be https",
        "entry demo: empty title",
        "entry demo: empty description",
      ]),
    );
  });

  it("needs exactly one of command or url", () => {
    expect(validateMcpCatalog(minimal({ server: {} }))).toContain(
      "entry demo: server needs exactly one of command or url",
    );
    expect(
      validateMcpCatalog(minimal({ server: { command: "npx", url: "https://x.test/mcp" } })),
    ).toContain("entry demo: server needs exactly one of command or url");
  });

  it("keeps keys out of urls", () => {
    const problems = validateMcpCatalog(
      minimal({
        server: { url: "https://x.test/mcp?key=<your key>" },
        inputs: [{ placeholder: "<your key>", label: "Key", secret: true, getUrl: "https://x.test" }],
      }),
    );
    expect(problems).toContain("entry demo: url must be https with no placeholder in it");
  });

  it("matches placeholders and inputs both ways", () => {
    const unused = validateMcpCatalog(
      minimal({ inputs: [{ placeholder: "<your key>", label: "Key", secret: false }] }),
    );
    expect(unused).toContain("entry demo: input <your key> is not used in server");
    const undeclared = validateMcpCatalog(
      minimal({ server: { command: "npx", env: { K: "<your key>" } } }),
    );
    expect(undeclared).toContain("entry demo: placeholder <your key> has no input");
  });

  it("asks secret inputs for a link to get the key", () => {
    const problems = validateMcpCatalog(
      minimal({
        server: { command: "npx", env: { K: "<your key>" } },
        inputs: [{ placeholder: "<your key>", label: "Key", secret: true }],
      }),
    );
    expect(problems).toContain("entry demo: secret input <your key> needs a getUrl");
  });
});
