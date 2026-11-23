import { describe, expect, it } from "vitest";

import { listIntegrations } from "../../integrations/integration-registry.js";
import { PROVIDER_PRESETS } from "../../llm/provider/presets/provider-presets.js";
import { listMcpCatalog } from "../../mcp/mcp-catalog.js";
import { parseHexColor } from "../theme/parse-hex-color.js";
import { IMPORT_SOURCE_IDS } from "../import/import-sources.js";
import {
  BRAND_BADGE_WIDTH,
  BRAND_LETTERS_MAX,
  BRAND_SLOT_WIDTH,
  BRANDS,
  brandBadgeText,
  brandFor,
  importSourceBrand,
  integrationBrand,
  mcpCatalogBrand,
  modelBrand,
  modelBrandKey,
  providerBrand,
  providerBrandKey,
  providerRowBrand,
} from "./brand-badges.js";

describe("the brand table", () => {
  it("gives every brand one or two plain letters and a parseable colour", () => {
    for (const [key, brand] of Object.entries(BRANDS)) {
      expect(brand.letters.length, key).toBeGreaterThanOrEqual(1);
      expect(brand.letters.length, key).toBeLessThanOrEqual(BRAND_LETTERS_MAX);
      // Printable ASCII only: no Nerd Font glyph, nothing a plain
      // terminal font could draw as a box.
      expect(brand.letters, key).toMatch(/^[A-Za-z0-9]+$/);
      expect(brand.hex, key).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(parseHexColor(brand.hex), key).not.toBeNull();
    }
  });

  it("answers null, never a guess, for an unknown key", () => {
    expect(brandFor("not-a-brand")).toBeNull();
    expect(brandFor(null)).toBeNull();
    expect(brandFor(undefined)).toBeNull();
    // Inherited object keys are not brands.
    expect(brandFor("toString")).toBeNull();
  });
});

describe("modelBrandKey", () => {
  it.each([
    ["anthropic/claude-sonnet-4.5", "claude"],
    ["claude-opus-5", "claude"],
    ["openai/gpt-5.4-mini", "openai"],
    ["gpt-6.2", "openai"],
    ["o3-mini", "openai"],
    ["openai/o4", "openai"],
    ["qwen/qwen3.7-max", "qwen"],
    ["qwq-32b", "qwen"],
    ["gemma-4-e4b", "google"],
    ["google/gemini-3-pro", "gemini"],
    ["deepseek/deepseek-v4", "deepseek"],
    ["nvidia/nemotron-ultra", "nvidia"],
    ["z-ai/glm-5", "zhipu"],
    ["mistralai/devstral-medium", "mistral"],
    ["codestral-latest", "mistral"],
    ["x-ai/grok-5", "xai"],
    ["moonshotai/kimi-k3", "moonshot"],
    ["perplexity/sonar-pro", "perplexity"],
    ["nousresearch/hermes-5-70b", "nous"],
    ["meta-llama/llama-4-maverick", "meta"],
    ["microsoft/phi-5", "microsoft"],
    ["phi4-mini", "microsoft"],
    ["openrouter/auto", "openrouter"],
  ])("%s wears %s", (id, key) => {
    expect(modelBrandKey(id)).toBe(key);
  });

  it("checks families in the desktop's order", () => {
    // A Claude-distilled Qwen is still listed by the desktop as Claude,
    // because `claude` is tested first; the terminal must agree.
    expect(modelBrandKey("qwen-claude-distill")).toBe("claude");
    // Gemma before Gemini: `gemma` is Google's own mark.
    expect(modelBrandKey("gemma-gemini-mix")).toBe("google");
  });

  it("leaves an id with no family blank", () => {
    expect(modelBrandKey("vendor/model-150")).toBeNull();
    expect(modelBrandKey("m-000")).toBeNull();
    expect(modelBrandKey("")).toBeNull();
    expect(modelBrandKey(undefined)).toBeNull();
    // `phi` inside an unrelated word is not Microsoft's Phi.
    expect(modelBrandKey("delphi-7b")).toBeNull();
    expect(modelBrand("vendor/model-150")).toBeNull();
  });
});

describe("providerBrandKey", () => {
  it.each([
    ["openrouter", "openrouter"],
    ["gemini", "gemini"],
    ["claude-cli", "claudecode"],
    ["codex-cli", "codex"],
    ["anthropic", "anthropic"],
    ["groq", "groq"],
    ["dashscope", "qwen"],
    ["bedrock", "aws"],
    ["azure-openai", "azure"],
    ["google-vertex", "google"],
    ["xai", "xai"],
  ])("%s wears %s", (id, key) => {
    expect(providerBrandKey(id)).toBe(key);
  });

  it("tolerates the numbered suffix a second entry of a preset gets", () => {
    expect(providerBrandKey("groq-2")).toBe("groq");
    expect(providerBrandKey("GROQ")).toBe("groq");
  });

  it("never brands a custom endpoint or the local seat", () => {
    expect(providerBrandKey("openai-compatible")).toBeNull();
    expect(providerBrandKey("local-llama")).toBeNull();
    expect(providerBrandKey("llama-server")).toBeNull();
    expect(providerBrandKey("my-office-box")).toBeNull();
    expect(providerBrand("")).toBeNull();
  });

  it("knows every preset it has a badge for, and only names real presets", () => {
    // A preset added later without a badge is allowed (it draws blank);
    // these are the ones that must keep theirs.
    const presetIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
    const branded = PROVIDER_PRESETS.filter(
      (preset) => providerBrandKey(preset.id) !== null,
    ).map((preset) => preset.id);
    expect(branded).toEqual(
      expect.arrayContaining([
        "anthropic",
        "deepseek",
        "groq",
        "mistral",
        "xai",
        "dashscope",
      ]),
    );
    for (const id of branded) expect(presetIds.has(id)).toBe(true);
  });
});

describe("providerRowBrand", () => {
  it("reads the entry id first, then its kind, then its CLI", () => {
    expect(providerRowBrand({ id: "groq", kind: "openai-compatible" })).toBe(
      BRANDS.groq,
    );
    expect(providerRowBrand({ id: "work", kind: "openrouter" })).toBe(
      BRANDS.openrouter,
    );
    expect(
      providerRowBrand({
        id: "my-plan",
        kind: "subscription-cli",
        subscriptionCli: { cli: "claude" },
      }),
    ).toBe(BRANDS.claudecode);
  });

  it("leaves a custom endpoint blank", () => {
    expect(
      providerRowBrand({
        id: "office",
        kind: "openai-compatible",
        subscriptionCli: null,
      }),
    ).toBeNull();
  });
});

describe("integration, MCP and import brands", () => {
  it("brands the integrations with a vendor and leaves ours blank", () => {
    expect(integrationBrand("telegram")).toBe(BRANDS.telegram);
    expect(integrationBrand("discord")).toBe(BRANDS.discord);
    expect(integrationBrand("github")).toBe(BRANDS.github);
    expect(integrationBrand("exa")).toBe(BRANDS.exa);
    expect(integrationBrand("atomic-mail")).toBeNull();
    // Every registered integration resolves without throwing.
    for (const descriptor of listIntegrations()) {
      expect(() => integrationBrand(descriptor.id)).not.toThrow();
    }
  });

  it("brands catalog MCP servers by vendor, never a user's own server", () => {
    expect(mcpCatalogBrand("github")).toBe(BRANDS.github);
    expect(mcpCatalogBrand("playwright")).toBe(BRANDS.playwright);
    expect(mcpCatalogBrand("brave-search")).toBe(BRANDS.brave);
    expect(mcpCatalogBrand("filesystem")).toBeNull();
    expect(mcpCatalogBrand("my-own-server")).toBeNull();
    const ids = new Set(listMcpCatalog().map((entry) => entry.id));
    for (const id of [
      "git",
      "github",
      "playwright",
      "context7",
      "notion",
      "exa",
      "firecrawl",
      "apify",
      "brightdata",
      "brave-search",
    ]) {
      // The table only names entries the catalog really has.
      expect(ids.has(id), id).toBe(true);
      expect(mcpCatalogBrand(id), id).not.toBeNull();
    }
  });

  it("brands the import sources it knows", () => {
    expect(importSourceBrand("claude-code")).toBe(BRANDS.claudecode);
    expect(importSourceBrand("codex")).toBe(BRANDS.codex);
    expect(importSourceBrand("hermes")).toBe(BRANDS.hermes);
    expect(importSourceBrand("openclaw")).toBe(BRANDS.openclaw);
    expect(importSourceBrand("pi")).toBeNull();
    for (const id of IMPORT_SOURCE_IDS) {
      expect(() => importSourceBrand(id)).not.toThrow();
    }
  });
});

describe("brandBadgeText", () => {
  it("is the same width for one letter, two letters and no brand", () => {
    expect(brandBadgeText(BRANDS.anthropic)).toHaveLength(BRAND_BADGE_WIDTH);
    expect(brandBadgeText(BRANDS.openrouter)).toHaveLength(BRAND_BADGE_WIDTH);
    expect(brandBadgeText(null)).toHaveLength(BRAND_BADGE_WIDTH);
    for (const brand of Object.values(BRANDS)) {
      expect(brandBadgeText(brand)).toHaveLength(BRAND_BADGE_WIDTH);
    }
  });

  it("pads the letters and leaves an unknown brand plain blank", () => {
    expect(brandBadgeText(BRANDS.openrouter)).toBe(" OR ");
    expect(brandBadgeText(BRANDS.anthropic)).toBe(" A  ");
    expect(brandBadgeText(null)).toBe("    ");
    expect(BRAND_SLOT_WIDTH).toBe(BRAND_BADGE_WIDTH + 1);
  });
});
