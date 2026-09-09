import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every OpenAI-shaped cloud kind must forward the two per-entry
 * passthroughs to its provider.
 *
 * These are wired per factory rather than in one place, and the ones
 * with their own wrapper class (`openrouter`, `aimlapi`, `gemini` all
 * extend `OpenAiProvider`) were silently missing both: an operator who
 * set `maxOutputTokens` on an `openrouter` entry got no ceiling at all,
 * the service reserved the model's full maximum, and requests came back
 * 402 while the chain quietly served a local model instead. Asserted
 * over the source because the failure is an omission at a call site —
 * there is nothing to catch at runtime, and each new kind is one more
 * chance to forget.
 */
describe("cloud provider factories", () => {
  const src = readFileSync(
    join(import.meta.dirname, "register-built-in-providers.ts"),
    "utf8",
  );

  const factories = src
    .split(/registerProviderKind\(/)
    .slice(1)
    .map((chunk) => ({
      kind: /^"([^"]+)"|^([A-Z_]+)/.exec(chunk)?.[1] ?? "(constant)",
      body: chunk.slice(0, chunk.indexOf("registerProviderKind") + 1 || undefined),
    }));

  const openAiShaped = ["openai-compatible", "qwen-openai-compatible", "openrouter", "aimlapi", "gemini"];

  it.each(openAiShaped)("%s forwards maxOutputTokens", (kind) => {
    const f = factories.find((x) => x.kind === kind);
    expect(f, `no factory for ${kind}`).toBeDefined();
    expect(f!.body).toContain("maxOutputTokens: entry.maxOutputTokens");
  });

  it.each(openAiShaped)("%s forwards extraBody", (kind) => {
    const f = factories.find((x) => x.kind === kind);
    expect(f!.body).toContain("extraBody: entry.extraBody");
  });
});
