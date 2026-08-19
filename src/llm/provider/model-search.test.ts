import { describe, expect, it } from "vitest";

import type { ModelCatalogEntry } from "./model-resolver.js";
import {
  modelSearchTags,
  searchModelIds,
  searchModels,
  splitQueryTerms,
} from "./model-search.js";

function entry(over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: over.id ?? "x",
    kind: "chat",
    contextWindow: 128_000,
    supportsVision: false,
    supportsTools: "parallel",
    supportsPromptCache: false,
    reasoningFormat: "none",
    ...over,
  } as ModelCatalogEntry;
}

const CATALOG: readonly { id: string; entry: ModelCatalogEntry }[] = [
  {
    id: "anthropic/claude-opus-5",
    entry: entry({
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 5, output: 25 },
    }),
  },
  {
    id: "anthropic/claude-haiku-4.5",
    entry: entry({
      contextWindow: 200_000,
      supportsVision: true,
      pricing: { input: 0.8, output: 4 },
    }),
  },
  {
    id: "qwen/qwen3.6-flash",
    entry: entry({ contextWindow: 1_000_000, pricing: { input: 0.19, output: 1.13 } }),
  },
  {
    id: "openai/gpt-oss-20b",
    entry: entry({ contextWindow: 131_072, pricing: { input: 0, output: 0 } }),
  },
];

const ids = (rows: readonly { id: string }[]): readonly string[] =>
  rows.map((row) => row.id);

describe("splitQueryTerms", () => {
  it("lowercases, trims and drops empty terms", () => {
    expect(splitQueryTerms("  Claude   VISION ")).toEqual(["claude", "vision"]);
    expect(splitQueryTerms("   ")).toEqual([]);
  });
});

describe("searchModels", () => {
  it("returns everything, in order, for an empty query", () => {
    expect(searchModels(CATALOG, "")).toBe(CATALOG);
    expect(searchModels(CATALOG, "   ")).toBe(CATALOG);
  });

  it("keeps the old substring behaviour for a single term", () => {
    expect(ids(searchModels(CATALOG, "claude"))).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(ids(searchModels(CATALOG, "OPUS"))).toEqual(["anthropic/claude-opus-5"]);
  });

  it("ANDs multiple terms instead of matching the raw string", () => {
    // "claude vision" is not a substring of any id — this is the query
    // the old single-`includes` filter answered with an empty list.
    expect(ids(searchModels(CATALOG, "claude vision"))).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(ids(searchModels(CATALOG, "claude 1m"))).toEqual([
      "anthropic/claude-opus-5",
    ]);
    expect(searchModels(CATALOG, "claude qwen")).toEqual([]);
  });

  it("matches capability and price tags off the catalog entry", () => {
    expect(ids(searchModels(CATALOG, "free"))).toEqual(["openai/gpt-oss-20b"]);
    // The tag follows the rendered price, so a router row is "routed",
    // never "free", and never "cheap" either.
    const auto = [
      { id: "openrouter/auto", entry: entry({ pricing: { input: 0, output: 0 } }) },
    ];
    expect(ids(searchModels(auto, "routed"))).toEqual(["openrouter/auto"]);
    expect(searchModels(auto, "free")).toEqual([]);
    expect(searchModels(auto, "cheap")).toEqual([]);
    expect(ids(searchModels(CATALOG, "cache"))).toEqual(["anthropic/claude-opus-5"]);
    expect(ids(searchModels(CATALOG, "cheap"))).toEqual([
      "anthropic/claude-haiku-4.5",
      "qwen/qwen3.6-flash",
    ]);
  });

  it("matches the vendor prefix", () => {
    expect(ids(searchModels(CATALOG, "anthropic"))).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-4.5",
    ]);
  });

  it("ranks exact ids and prefixes above buried substrings", () => {
    const rows = [
      { id: "vendor/needs-opus-handling", entry: entry() },
      { id: "opus", entry: entry() },
      { id: "opus-mini", entry: entry() },
    ];
    expect(ids(searchModels(rows, "opus"))).toEqual([
      "opus",
      "opus-mini",
      "vendor/needs-opus-handling",
    ]);
  });

  it("keeps input order between equally ranked rows", () => {
    // The catalogs are hand-ordered and this runs on every keystroke, so
    // equal matches must not shuffle under the cursor.
    const rows = [
      { id: "a/model-one", entry: entry() },
      { id: "a/model-two", entry: entry() },
      { id: "a/model-three", entry: entry() },
    ];
    expect(ids(searchModels(rows, "model"))).toEqual([
      "a/model-one",
      "a/model-two",
      "a/model-three",
    ]);
  });

  it("falls back to a subsequence match, ranked last", () => {
    const rows = [
      { id: "openai/gpt-oss-20b", entry: entry() },
      { id: "vendor/gpt", entry: entry() },
    ];
    // "gpto" is nobody's substring; it is a subsequence of the first id.
    expect(ids(searchModels(rows, "gpto"))).toEqual(["openai/gpt-oss-20b"]);
  });

  it("still matches ids with no catalog entry, on the id alone", () => {
    const rows = [{ id: "some-local-model" }, { id: "other" }];
    expect(ids(searchModels(rows, "local"))).toEqual(["some-local-model"]);
    // No entry means no tags, so a capability term cannot match.
    expect(searchModels(rows, "vision")).toEqual([]);
  });
});

describe("context window terms", () => {
  // Ids are deliberately digit-free: a row must match on its window, not
  // because "1m" happens to be a substring or subsequence of its id.
  const WINDOWS: readonly { id: string; entry: ModelCatalogEntry }[] = [
    { id: "vendor/alpha", entry: entry({ contextWindow: 1_000_000 }) },
    { id: "vendor/bravo", entry: entry({ contextWindow: 1_048_576 }) },
    { id: "vendor/charlie", entry: entry({ contextWindow: 1_050_000 }) },
    { id: "vendor/delta", entry: entry({ contextWindow: 1_310_720 }) },
    { id: "vendor/echo", entry: entry({ contextWindow: 2_000_000 }) },
    { id: "vendor/foxtrot", entry: entry({ contextWindow: 131_072 }) },
    { id: "vendor/golf", entry: entry({ contextWindow: 204_800 }) },
  ];

  it("`1m` finds every roughly-1M window, not only the ones rendered as 1m", () => {
    // The bug this pins: the tag used to be the display string alone, so
    // only the exactly-1_000_000 row answered to `1m` and an operator
    // concluded the 1.0m/1.1m/1.3m rows had no million-token variant.
    expect(ids(searchModels(WINDOWS, "1m"))).toEqual([
      "vendor/alpha",
      "vendor/bravo",
      "vendor/charlie",
      "vendor/delta",
    ]);
    // Floor, not round: 2M is its own bucket and nothing under 1M leaks in.
    expect(ids(searchModels(WINDOWS, "2m"))).toEqual(["vendor/echo"]);
  });

  it("keeps answering to the string the row displays", () => {
    expect(ids(searchModels(WINDOWS, "1.0m"))).toEqual(["vendor/bravo"]);
    expect(ids(searchModels(WINDOWS, "1.1m"))).toEqual(["vendor/charlie"]);
    expect(ids(searchModels(WINDOWS, "1.3m"))).toEqual(["vendor/delta"]);
    expect(ids(searchModels(WINDOWS, "131k"))).toEqual(["vendor/foxtrot"]);
    expect(ids(searchModels(WINDOWS, "205k"))).toEqual(["vendor/golf"]);
  });

  it("answers to the binary reading of a power-of-two window", () => {
    // 131_072 is sold as 128k and 204_800 as 200k; decimal rounding is
    // what hid them.
    expect(ids(searchModels(WINDOWS, "128k"))).toEqual(["vendor/foxtrot"]);
    expect(ids(searchModels(WINDOWS, "200k"))).toEqual(["vendor/golf"]);
    // A window that was never binary keeps only its decimal reading.
    const decimal = [{ id: "vendor/hotel", entry: entry({ contextWindow: 200_000 }) }];
    expect(ids(searchModels(decimal, "200k"))).toEqual(["vendor/hotel"]);
    expect(searchModels(decimal, "195k")).toEqual([]);
  });
});

describe("modelSearchTags", () => {
  it("derives tags from the entry and nothing else", () => {
    expect(modelSearchTags(undefined)).toEqual([]);
    expect(
      modelSearchTags(
        entry({
          contextWindow: 200_000,
          supportsVision: true,
          supportsPromptCache: true,
          pricing: { input: 0, output: 0 },
        }),
      ),
    ).toEqual(["chat", "vision", "tools", "cache", "200k", "free"]);
  });

  it("tags a window as displayed, floored to the whole unit, and in binary", () => {
    // The first three tags are kind / modality / tools; window forms follow.
    const windowTags = (contextWindow: number): readonly string[] =>
      modelSearchTags(entry({ contextWindow })).slice(3);
    expect(windowTags(1_000_000)).toEqual(["1m"]);
    expect(windowTags(1_048_576)).toEqual(["1.0m", "1m"]);
    expect(windowTags(1_310_720)).toEqual(["1.3m", "1m"]);
    expect(windowTags(131_072)).toEqual(["131k", "128k"]);
    expect(windowTags(204_800)).toEqual(["205k", "204k", "200k"]);
    expect(windowTags(200_000)).toEqual(["200k"]);
    // Below a thousand there is no shorthand to normalise.
    expect(windowTags(512)).toEqual(["512"]);
  });
});

describe("searchModelIds", () => {
  it("searches plain ids and uses the lookup for metadata when given", () => {
    const all = CATALOG.map((row) => row.id);
    const lookup = (id: string): ModelCatalogEntry | undefined =>
      CATALOG.find((row) => row.id === id)?.entry;
    expect(searchModelIds(all, "vision", lookup)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-4.5",
    ]);
    // Without the lookup the same query has no metadata to match on.
    expect(searchModelIds(all, "vision")).toEqual([]);
    expect(searchModelIds(all, "")).toBe(all);
  });
});
