import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUserConfigPath } from "../config/config-file.js";
import { resetConfigCache } from "../config/index.js";
import { USER_CONFIG_VERSION } from "../config/config-schema.js";

import {
  collectHits,
  parseModelsSearchArgs,
  runModelsSearch,
} from "./models-search-command.js";

describe("parseModelsSearchArgs", () => {
  it("joins bare words into one query and reads the flags", () => {
    const parsed = parseModelsSearchArgs([
      "claude",
      "vision",
      "--limit",
      "5",
      "--json",
      "--provider",
      "or",
    ]);
    expect(parsed).toEqual({
      query: "claude vision",
      provider: "or",
      limit: 5,
      json: true,
      refresh: false,
    });
  });

  it("rejects a non-positive limit and unknown flags", () => {
    expect(() => parseModelsSearchArgs(["x", "--limit", "0"])).toThrow(/--limit/);
    expect(() => parseModelsSearchArgs(["x", "--nope"])).toThrow(/unknown flag/);
  });
});

describe("runModelsSearch", () => {
  let stateDir: string;
  let out: string[];
  let err: string[];

  function writeConfig(): void {
    writeFileSync(
      getUserConfigPath(stateDir),
      JSON.stringify({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "or",
          activeEmbeddingProvider: "or",
          toolTransport: "auto",
          providers: [
            { id: "or", kind: "openrouter", defaultChatModel: "openrouter/auto" },
            {
              id: "vllm",
              kind: "openai-compatible",
              baseUrl: "http://127.0.0.1:8000",
              defaultChatModel: "local/mistral",
            },
          ],
        },
      }),
      "utf8",
    );
    resetConfigCache();
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-search-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("finds catalog models by id and prints provider, context, price and caps", async () => {
    writeConfig();
    const code = await runModelsSearch(["qwen"]);
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^or\s+qwen\//m);
    expect(out.join("")).toMatch(/tools/);
  });

  it("ANDs terms across id and capability tags", async () => {
    writeConfig();
    // The old TUI filter answered this with nothing: "qwen vision" is not
    // a substring of any id.
    expect(await runModelsSearch(["qwen", "vision", "--json"])).toBe(0);
    const rows = JSON.parse(out.join("")) as {
      id: string;
      supportsVision: boolean;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.id).toMatch(/qwen/);
      expect(row.supportsVision).toBe(true);
    }
  });

  it("`1m` returns every million-token row, whatever its rendered size reads", async () => {
    writeConfig();
    // The README advertises this query. The bundled OpenRouter catalog
    // holds 1_000_000, 1_048_576 and 1_050_000 windows, which render as
    // `1m`, `1.0m` and `1.1m`; only the first used to answer to `1m`.
    expect(await runModelsSearch(["1m", "--json"])).toBe(0);
    const rows = JSON.parse(out.join("")) as {
      id: string;
      contextWindow: number;
    }[];
    const windows = new Set(rows.map((row) => row.contextWindow));
    expect(windows).toEqual(new Set([1_000_000, 1_048_576, 1_050_000]));
    for (const row of rows) {
      expect(row.contextWindow).toBeGreaterThanOrEqual(1_000_000);
      // `openrouter/auto` is 2M and belongs to `2m`, not to `1m`.
      expect(row.contextWindow).toBeLessThan(2_000_000);
    }

    // Same normalisation one unit down: 262_144 renders as `262k` and is
    // sold as 256k.
    out.length = 0;
    expect(await runModelsSearch(["256k", "--json"])).toBe(0);
    const kilo = JSON.parse(out.join("")) as { contextWindow: number }[];
    expect(kilo.length).toBeGreaterThan(0);
    for (const row of kilo) expect(row.contextWindow).toBe(262_144);
  });

  it("includes models an entry carries under userModels", async () => {
    // Read straight off the entry: `parseLlmProviderEntry` currently
    // drops `userModels` on the way out of config.json, so this path
    // cannot be reached through a config fixture.
    const hits = await collectHits(
      [
        {
          id: "vllm",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:8000",
          userModels: [
            {
              id: "local/mistral",
              kind: "chat",
              contextWindow: 32_000,
            },
          ],
        },
      ],
      false,
    );
    expect(hits).toEqual([{ providerId: "vllm", id: "local/mistral" }]);
  });

  it("narrows to one provider entry and caps the result count", async () => {
    writeConfig();
    // `vllm` ships no bundled catalog, so restricting to it finds nothing
    // to search rather than silently falling back to the other provider.
    expect(await runModelsSearch(["--provider", "vllm", "qwen"])).toBe(1);
    expect(err.join("")).toMatch(/no searchable cloud models/);

    out.length = 0;
    expect(await runModelsSearch(["qwen", "--limit", "1"])).toBe(0);
    expect(out.join("").trimEnd().split("\n")).toHaveLength(1);
  });

  it("exits 1 with one line — never a stack trace — when nothing matches", async () => {
    writeConfig();
    expect(await runModelsSearch(["definitely-not-a-model"])).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/no model matches/);
  });

  it("exits 1 on a missing query or an unknown provider id", async () => {
    writeConfig();
    expect(await runModelsSearch([])).toBe(1);
    expect(err.join("")).toMatch(/expects a query/);

    err.length = 0;
    expect(await runModelsSearch(["--provider", "nope", "qwen"])).toBe(1);
    expect(err.join("")).toMatch(/no configured provider/);
  });

  it("says so instead of printing nothing when no provider ships a catalog", async () => {
    // Default config: one local llama-server entry, no cloud catalog.
    expect(await runModelsSearch(["qwen"])).toBe(1);
    expect(err.join("")).toMatch(/no searchable cloud models/);
  });

  // Last in the file on purpose: a live refresh writes the fetcher's
  // module-global pick cache, which outlives this test.
  it("--refresh searches the live catalog, not just the bundled snapshot", async () => {
    writeConfig();
    expect(await runModelsSearch(["brand-new-model"])).toBe(1);

    out.length = 0;
    err.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/brand-new-model",
              name: "Brand New",
              context_length: 256_000,
              pricing: { prompt: "0.000001", completion: "0.000004" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text"] },
            },
          ],
        }),
      })),
    );
    expect(await runModelsSearch(["brand-new-model", "--refresh"])).toBe(0);
    expect(out.join("")).toContain("vendor/brand-new-model");
    vi.unstubAllGlobals();
  });
});
