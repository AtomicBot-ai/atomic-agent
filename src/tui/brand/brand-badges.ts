/**
 * Brand badges for the terminal (ATO-1635).
 *
 * The desktop draws a real logo next to every provider, model family,
 * integration, MCP server and import source. A terminal cannot draw a
 * logo by default (inline images work only in kitty/Ghostty with an
 * opt-in, and never under tmux), so the terminal's stand-in is a short
 * badge: one or two letters on the brand's own colour, always the same
 * width so the columns beside it never shift.
 *
 * Rules the table keeps:
 *
 * - Only brands we can name with confidence get a badge. Anything else
 *   (a custom OpenAI-compatible endpoint, a user's own MCP server, a
 *   reference server with no vendor) gets `null`, which the renderer
 *   draws as a blank of the same width. Never a made-up monogram: a
 *   badge reads as "this is that vendor", and a guessed one would lie.
 * - Colours are each vendor's published brand colour (simple-icons data
 *   where it has the vendor).
 * - No Nerd Font glyphs: plain letters render in every terminal font.
 *
 * The model-family mapping mirrors the desktop's `modelLogoKey`
 * (`desktop/renderer/renderer.js`) so a model wears the same brand in
 * both apps.
 */

export interface Brand {
  /** One or two characters drawn on the badge. */
  readonly letters: string;
  /** Badge ground, `#rrggbb`. */
  readonly hex: string;
  /** Human name, for tests and for anyone reading the table. */
  readonly name: string;
}

/** Longest `letters` value; the badge is sized for it. */
export const BRAND_LETTERS_MAX = 2;

export const BRANDS = {
  anthropic: { letters: "A", hex: "#D97757", name: "Anthropic" },
  claude: { letters: "C", hex: "#D97757", name: "Claude" },
  claudecode: { letters: "CC", hex: "#D97757", name: "Claude Code" },
  openai: { letters: "OA", hex: "#412991", name: "OpenAI" },
  codex: { letters: "CX", hex: "#412991", name: "OpenAI Codex" },
  openrouter: { letters: "OR", hex: "#6566F1", name: "OpenRouter" },
  google: { letters: "G", hex: "#4285F4", name: "Google" },
  gemini: { letters: "G", hex: "#8E75B2", name: "Gemini" },
  qwen: { letters: "Q", hex: "#615CED", name: "Qwen" },
  deepseek: { letters: "DS", hex: "#4D6BFE", name: "DeepSeek" },
  mistral: { letters: "M", hex: "#FA520F", name: "Mistral AI" },
  xai: { letters: "X", hex: "#000000", name: "xAI" },
  moonshot: { letters: "K", hex: "#1783FF", name: "Moonshot AI (Kimi)" },
  zhipu: { letters: "Z", hex: "#3859FF", name: "Zhipu AI (GLM)" },
  nvidia: { letters: "NV", hex: "#76B900", name: "NVIDIA" },
  perplexity: { letters: "P", hex: "#1FB8CD", name: "Perplexity" },
  nous: { letters: "N", hex: "#000000", name: "Nous Research" },
  meta: { letters: "L", hex: "#0467DF", name: "Meta (Llama)" },
  microsoft: { letters: "MS", hex: "#5E5E5E", name: "Microsoft" },
  azure: { letters: "AZ", hex: "#0078D4", name: "Microsoft Azure" },
  aws: { letters: "AW", hex: "#FF9900", name: "Amazon Web Services" },
  groq: { letters: "GQ", hex: "#F55036", name: "Groq" },
  cerebras: { letters: "CB", hex: "#F15A29", name: "Cerebras" },
  fireworks: { letters: "FW", hex: "#6720FF", name: "Fireworks AI" },
  together: { letters: "T", hex: "#0F6FFF", name: "Together AI" },
  sambanova: { letters: "SN", hex: "#EE7624", name: "SambaNova" },
  wandb: { letters: "WB", hex: "#FFBE00", name: "Weights & Biases" },
  ollama: { letters: "OL", hex: "#000000", name: "Ollama" },
  huggingface: { letters: "HF", hex: "#FFD21E", name: "Hugging Face" },
  github: { letters: "GH", hex: "#181717", name: "GitHub" },
  git: { letters: "GT", hex: "#F05032", name: "Git" },
  playwright: { letters: "PW", hex: "#2EAD33", name: "Playwright" },
  context7: { letters: "C7", hex: "#00E9A3", name: "Context7 (Upstash)" },
  notion: { letters: "N", hex: "#000000", name: "Notion" },
  exa: { letters: "EX", hex: "#1F40ED", name: "Exa" },
  firecrawl: { letters: "FC", hex: "#FF4500", name: "Firecrawl" },
  apify: { letters: "AP", hex: "#97D700", name: "Apify" },
  brightdata: { letters: "BD", hex: "#3D7FFC", name: "Bright Data" },
  brave: { letters: "B", hex: "#FB542B", name: "Brave" },
  telegram: { letters: "TG", hex: "#26A5E4", name: "Telegram" },
  discord: { letters: "DC", hex: "#5865F2", name: "Discord" },
  hermes: { letters: "H", hex: "#000000", name: "Hermes Agent" },
  openclaw: { letters: "OC", hex: "#E5484D", name: "OpenClaw" },
} as const satisfies Record<string, Brand>;

export type BrandKey = keyof typeof BRANDS;

function isBrandKey(value: string): value is BrandKey {
  return Object.prototype.hasOwnProperty.call(BRANDS, value);
}

/** The brand behind a key, or `null` for `null`/unknown keys. */
export function brandFor(key: string | null | undefined): Brand | null {
  if (!key || !isBrandKey(key)) return null;
  return BRANDS[key];
}

/**
 * Model id → the family whose brand it wears (`null` when there is none).
 * Same order and the same tests as the desktop's `modelLogoKey`, plus
 * Llama and Phi, which the desktop shows as a plain CPU icon because it
 * has no logo file for them.
 */
export function modelBrandKey(id: string | null | undefined): BrandKey | null {
  const s = String(id ?? "").toLowerCase();
  if (!s) return null;
  if (s.includes("claude")) return "claude";
  if (s.includes("gpt") || s.startsWith("openai/") || /(^|\/)o[134](-|$)/.test(s)) {
    return "openai";
  }
  if (s.includes("qwen") || s.includes("qwq")) return "qwen";
  // Gemma wears Google's brand, as on the desktop.
  if (s.includes("gemma")) return "google";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("nemotron")) return "nvidia";
  if (s.includes("glm")) return "zhipu";
  if (
    s.includes("mistral") ||
    s.includes("devstral") ||
    s.includes("magistral") ||
    s.includes("codestral")
  ) {
    return "mistral";
  }
  if (s.includes("grok")) return "xai";
  if (s.includes("kimi")) return "moonshot";
  if (s.includes("sonar")) return "perplexity";
  if (s.includes("hermes")) return "nous";
  if (s.includes("llama")) return "meta";
  if (/(^|[/_-])phi-?\d/.test(s)) return "microsoft";
  if (s.startsWith("openrouter/")) return "openrouter";
  return null;
}

/** A model id's brand, or `null`. */
export function modelBrand(id: string | null | undefined): Brand | null {
  return brandFor(modelBrandKey(id));
}

/**
 * Provider ids (preset ids from `provider-presets.ts`, the wizard's own
 * kinds, and config `kind` values) → brand. A custom endpoint
 * (`openai-compatible`), llama.cpp and the local seat have no entry on
 * purpose.
 */
const PROVIDER_BRAND_KEYS: Readonly<Record<string, BrandKey>> = {
  // Wizard kinds and config kinds.
  "claude-cli": "claudecode",
  "codex-cli": "codex",
  openrouter: "openrouter",
  gemini: "gemini",
  openai: "openai",
  // Presets (src/llm/provider/presets/provider-presets.ts).
  bedrock: "aws",
  anthropic: "anthropic",
  "azure-openai": "azure",
  cerebras: "cerebras",
  deepseek: "deepseek",
  fireworks: "fireworks",
  "foundry-local": "microsoft",
  "google-vertex": "google",
  groq: "groq",
  mistral: "mistral",
  moonshot: "moonshot",
  nous: "nous",
  ollama: "ollama",
  "ollama-cloud": "ollama",
  perplexity: "perplexity",
  dashscope: "qwen",
  sambanova: "sambanova",
  together: "together",
  wandb: "wandb",
  xai: "xai",
  huggingface: "huggingface",
};

/** Subscription CLI name (`claude`, `codex`) → brand. */
const SUBSCRIPTION_CLI_BRAND_KEYS: Readonly<Record<string, BrandKey>> = {
  claude: "claudecode",
  codex: "codex",
};

function lookup(
  table: Readonly<Record<string, BrandKey>>,
  key: string,
): BrandKey | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : null;
}

/**
 * A provider id's brand key. Tolerates the numbered suffixes the wizard
 * hands out for a second entry of the same preset (`groq-2` is Groq).
 */
export function providerBrandKey(id: string | null | undefined): BrandKey | null {
  const s = String(id ?? "").toLowerCase().trim();
  if (!s) return null;
  const direct = lookup(PROVIDER_BRAND_KEYS, s);
  if (direct) return direct;
  const suffixed = /^(.+)-\d+$/.exec(s);
  return suffixed ? lookup(PROVIDER_BRAND_KEYS, suffixed[1]!) : null;
}

/** A provider id's brand, or `null`. */
export function providerBrand(id: string | null | undefined): Brand | null {
  return brandFor(providerBrandKey(id));
}

/**
 * The brand of a configured provider row: its entry id first (a preset
 * entry is named after its preset), then its config kind, then the CLI a
 * subscription entry drives. `openai-compatible` alone never earns a
 * brand: that kind is every custom endpoint there is.
 */
export function providerRowBrand(row: {
  readonly id: string;
  readonly kind: string;
  readonly subscriptionCli?: { readonly cli: string } | null;
}): Brand | null {
  const byId = providerBrandKey(row.id);
  if (byId) return brandFor(byId);
  const byKind = providerBrandKey(row.kind);
  if (byKind) return brandFor(byKind);
  const cli = row.subscriptionCli?.cli;
  return cli ? brandFor(lookup(SUBSCRIPTION_CLI_BRAND_KEYS, cli)) : null;
}

/** Integration descriptor ids (`src/integrations/*-integration.ts`) → brand. */
const INTEGRATION_BRAND_KEYS: Readonly<Record<string, BrandKey>> = {
  telegram: "telegram",
  discord: "discord",
  github: "github",
  exa: "exa",
};

export function integrationBrand(id: string | null | undefined): Brand | null {
  const s = String(id ?? "").toLowerCase();
  return brandFor(lookup(INTEGRATION_BRAND_KEYS, s));
}

/**
 * Built-in MCP catalog ids (`src/mcp/mcp-catalog-data.ts`) → brand. The
 * reference servers (filesystem, fetch, time, memory, sequential
 * thinking) have no vendor of their own and stay blank.
 */
const MCP_BRAND_KEYS: Readonly<Record<string, BrandKey>> = {
  git: "git",
  github: "github",
  playwright: "playwright",
  context7: "context7",
  notion: "notion",
  exa: "exa",
  firecrawl: "firecrawl",
  apify: "apify",
  brightdata: "brightdata",
  "brave-search": "brave",
};

export function mcpCatalogBrand(id: string | null | undefined): Brand | null {
  const s = String(id ?? "").toLowerCase();
  return brandFor(lookup(MCP_BRAND_KEYS, s));
}

/** Import source ids (`ImportAgentId`) → brand. */
const IMPORT_SOURCE_BRAND_KEYS: Readonly<Record<string, BrandKey>> = {
  "claude-code": "claudecode",
  codex: "codex",
  hermes: "hermes",
  openclaw: "openclaw",
};

export function importSourceBrand(id: string | null | undefined): Brand | null {
  const s = String(id ?? "").toLowerCase();
  return brandFor(lookup(IMPORT_SOURCE_BRAND_KEYS, s));
}

/** Cells a badge takes: one pad, two letters, one pad. */
export const BRAND_BADGE_WIDTH = BRAND_LETTERS_MAX + 2;

/** Cells the badge slot takes in a row: the badge plus one gap. */
export const BRAND_SLOT_WIDTH = BRAND_BADGE_WIDTH + 1;

/**
 * The badge face, exactly {@link BRAND_BADGE_WIDTH} cells. An unknown
 * brand is the same number of spaces, so a list that mixes known and
 * unknown rows keeps one column for its labels.
 */
export function brandBadgeText(brand: Brand | null): string {
  if (!brand) return " ".repeat(BRAND_BADGE_WIDTH);
  const letters = brand.letters.slice(0, BRAND_LETTERS_MAX);
  return ` ${letters.padEnd(BRAND_LETTERS_MAX)} `;
}
