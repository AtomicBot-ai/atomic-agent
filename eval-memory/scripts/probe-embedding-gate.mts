#!/usr/bin/env node
/**
 * Quick smoke for rewriter gates (heuristic + embedding).
 *
 * Heuristic checks run offline. Embedding checks need the embedding
 * daemon (default port 19092):
 *   atomic-agent models start
 *
 * Usage:
 *   npm run probe:embedding-gate
 *   npm run probe:embedding-gate -- --port=19092 --model=bge-base-en-v1.5
 */
import { probeLlamaHealth, getEmbeddingModelDef } from "../../src/local-llm/index.js";
import {
  EmbeddingUnavailableError,
  LlamaEmbeddingClient,
} from "../../src/memory/embeddings/embedding-client.js";
import { isReferentialMessage } from "../../src/memory/retrieve/referential-detector.js";
import { createEmbeddingGate } from "../../src/memory/retrieve/embedding-gate.js";
import { DEFAULT_REWRITER_EXEMPLARS } from "../../src/memory/retrieve/default-rewriter-exemplars.js";

const HISTORY = 3;

const CASES: { label: string; message: string }[] = [
  { label: "short referential (EN)", message: "and what about it" },
  { label: "referential exemplar-like", message: "tell me more about it" },
  {
    label: "long self-contained (LoCoMo-style)",
    message:
      "When did Caroline first mention her career goals at the mental health conference?",
  },
];

function parseArg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1] ?? fallback;
}

/** Probe daemon once; auto-correct dim when catalog id ≠ loaded GGUF. */
async function buildEmbeddingClient(
  port: number,
  modelId: string,
): Promise<LlamaEmbeddingClient> {
  const model = getEmbeddingModelDef(
    modelId as "bge-base-en-v1.5" | "nomic-embed-text-v1.5" | "bge-small-en-v1.5",
  );
  const url = `http://127.0.0.1:${port}`;
  let dim = model.dim;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = new LlamaEmbeddingClient({ url, dim, model: model.id });
    try {
      const r = await client.embed({ text: "probe" });
      if (r.vector.length !== dim) dim = r.vector.length;
      return new LlamaEmbeddingClient({ url, dim, model: model.id });
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
      const m = /got (\d+)/.exec(err.message);
      if (m && attempt === 0) {
        dim = Number.parseInt(m[1]!, 10);
        console.log(
          `  (catalog dim ${model.dim} ≠ daemon ${dim} — using daemon dim)\n`,
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function main(): Promise<number> {
  const port = Number.parseInt(parseArg("port", "19092"), 10);
  const modelId = parseArg("model", "bge-base-en-v1.5");
  const threshold = Number.parseFloat(parseArg("threshold", "0.65"));

  console.log("=== Heuristic gate (offline) ===\n");
  for (const c of CASES) {
    const fire = isReferentialMessage(c.message, HISTORY);
    console.log(`  ${fire ? "FIRE" : "skip"}  ${c.label}`);
    console.log(`         "${c.message.slice(0, 72)}${c.message.length > 72 ? "…" : ""}"`);
  }

  console.log("\n=== Embedding daemon ===\n");
  const health = await probeLlamaHealth(port).catch(() => "down" as const);
  console.log(`  port ${port}: ${health}`);
  if (health !== "ok") {
    console.log(
      "\n  Start embedding daemon: atomic-agent models start  (or TUI Models tab)\n",
    );
    return 1;
  }

  const client = await buildEmbeddingClient(port, modelId);

  const logger = {
    debug: (msg: string, fields?: Record<string, unknown>) => {
      console.log(`  [debug] ${msg}`, fields ?? "");
    },
    warn: (msg: string, fields?: Record<string, unknown>) => {
      console.log(`  [warn] ${msg}`, fields ?? "");
    },
  };

  const gate = createEmbeddingGate({
    embedder: client,
    exemplars: DEFAULT_REWRITER_EXEMPLARS,
    threshold,
    logger,
  });

  console.log(
    `\n=== Embedding gate (threshold=${threshold}, exemplars=${DEFAULT_REWRITER_EXEMPLARS.length}) ===\n`,
  );
  const signal = new AbortController().signal;
  for (const c of CASES) {
    const fire = await gate.check({
      message: c.message,
      historyTurnCount: HISTORY,
      signal,
    });
    console.log(`  ${fire ? "FIRE" : "skip"}  ${c.label}`);
    console.log(`         "${c.message.slice(0, 72)}${c.message.length > 72 ? "…" : ""}"`);
  }

  console.log("\nOK — compare FIRE vs skip above. Long LoCoMo questions should");
  console.log("     ideally FIRE under embedding even when heuristic skips.\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
