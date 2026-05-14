import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// A small module with rich comments encoding a deliberate design
// choice. The judge checks whether the agent surfaced that the cache
// is request-scoped (not global) and the eviction strategy is LRU.
const CACHE_SOURCE = [
  "/**",
  " * Per-request memoization for the prompt builder.",
  " *",
  " * Lifetime: ONE request. Cleared at the end of every runTurn so",
  " * memory is bounded and no cross-session leakage is possible.",
  " * Eviction: pure LRU at size 64; FIFO would risk evicting the",
  " * stable-prefix entry we hit every step.",
  " */",
  "export class PromptCache {",
  "  private readonly entries = new Map<string, string>();",
  "  private readonly capacity = 64;",
  "",
  "  get(key: string): string | undefined {",
  "    const value = this.entries.get(key);",
  "    if (value !== undefined) {",
  "      this.entries.delete(key);",
  "      this.entries.set(key, value);",
  "    }",
  "    return value;",
  "  }",
  "",
  "  set(key: string, value: string): void {",
  "    if (this.entries.size >= this.capacity) {",
  "      const oldest = this.entries.keys().next().value;",
  "      if (oldest !== undefined) this.entries.delete(oldest);",
  "    }",
  "    this.entries.set(key, value);",
  "  }",
  "",
  "  clearForTurn(): void { this.entries.clear(); }",
  "}",
  "",
].join("\n");

export const judgeExplainCacheDecision: EvalCase = {
  id: "judge-explain-cache-decision",
  name: "Explain the design intent of PromptCache",
  category: "os",
  prompt: `Read src/prompt-cache.ts and explain in 1-3 sentences: (1) what is the lifetime of this cache, and (2) what is its eviction strategy. Quote the rationale from the file when you can.`,
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "prompt-cache.ts"), CACHE_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    {
      kind: "judge",
      threshold: 4,
      rubric: `The reply MUST clearly state (a) the cache lifetime is per-request / per-turn (cleared at the end of every runTurn / clearForTurn), AND (b) the eviction strategy is LRU at capacity 64. Both facts are required for a passing score. Partial credit if only one is correct.`,
    },
  ],
};
