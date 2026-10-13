// Live check: notes memory + EmbeddingGemma 2 via Atomic Core, end to end.
// Inserts 3 notes with no vectors, attaches embeddings the way the runtime does,
// backfills, recalls by meaning (hybrid + the memory.notes.recall tool), cleans up.
// Run after `npm run build` with ATOMIC_AGENT_STATE_DIR set to the test profile.
import { getConfig } from "../dist/config/index.js";
import { MemoryStore } from "../dist/memory/memory-store.js";
import { connectMemoryEmbeddings } from "../dist/memory/embeddings/memory-embedding-connection.js";
import { EmbeddingStore, EmbeddingWriter, backfillEmbeddings, countPendingEmbeddings } from "../dist/memory/embeddings/index.js";
import { buildNotesRecallTool } from "../dist/tools/memory/notes-recall.js";

const config = getConfig();
console.log("DB", config.paths.memoryDbFile);

// Same options as createRuntimeMemoryStores, except dedup is off: a dedup merge
// would hand back an existing note's id and the cleanup would delete it.
const store = new MemoryStore({
  dbFile: config.paths.memoryDbFile,
  maxEntries: config.memory.notes.maxEntries,
  dedup: { enabled: false, fts5Threshold: config.memory.dedup.fts5Threshold },
  eviction: { utilityWeighted: config.memory.eviction.utilityWeighted, maxAgeMs: config.memory.eviction.maxAgeMs },
});

const notes = {
  cat: "Мой кот Барсик обожает свежие огурцы",
  vat: "Quarterly VAT return is due on the 25th",
  deploy: "The deploy script lives in scripts/release.sh",
};
const ids = {};
let failed = false;
const fail = (msg) => { failed = true; console.log("FAIL", msg); };

try {
  // 1. Insert before embeddings are attached: no vectors get written here.
  for (const [k, content] of Object.entries(notes)) {
    ids[k] = store.store({ content, tags: ["smoke-embed"], source: "user" }).id;
    console.log("NOTE", k, `#${ids[k]}`, content);
  }
  const byId = Object.fromEntries(Object.entries(ids).map(([k, id]) => [id, k]));

  // 2. Attach embeddings through the runtime's connection helper.
  const conn = await connectMemoryEmbeddings(config);
  console.log("CONNECTION", conn.state, conn.modelId ?? "", conn.why ?? "");
  if (conn.state !== "reachable") throw new Error(`embeddings not reachable (${conn.state})`);
  const client = conn.createClient();
  const db = store.getDatabaseHandleForEmbeddings();
  const embStore = new EmbeddingStore({ db });
  const writer = new EmbeddingWriter({ client, store: embStore });
  store.attachEmbeddings({
    writer,
    store: embStore,
    fts5Weight: config.memory.embeddings.fts5Weight,
    vectorWeight: config.memory.embeddings.vectorWeight,
    bruteForceCeiling: config.memory.embeddings.bruteForceCeiling,
  });
  for (const [k, id] of Object.entries(ids)) {
    if (embStore.get(id, client.model)) console.log("WARN", k, "already had a vector before backfill");
  }

  // 3. Backfill to completion.
  console.log("PENDING", countPendingEmbeddings(db, client.model), "model", client.model);
  const t0 = Date.now();
  const bf = await backfillEmbeddings({ db, writer }, { batchSize: 8, concurrency: 1 });
  console.log("BACKFILL", JSON.stringify(bf), `${Date.now() - t0}ms`);
  if (bf.stoppedReason || bf.remaining !== 0) fail(`backfill incomplete: ${JSON.stringify(bf)}`);
  for (const [k, id] of Object.entries(ids)) {
    const row = embStore.get(id, client.model);
    if (!row) fail(`no vector for ${k} #${id}`);
    else console.log("VECTOR", k, `#${id}`, `dim=${row.dim}`);
  }

  // 4. Hybrid recall.
  const cases = [
    ["what does my pet like to eat?", "cat"], // no shared word, other language: meaning only
    ["when are taxes due", "vat"],
    ["where is the release script", "deploy"],
  ];
  const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };
  for (const [q, want] of cases) {
    const hits = await store.recallHybridAsync(q, { k: 3, scope: "all" });
    const rank = hits.findIndex((e) => e.id === ids[want]);
    console.log(rank >= 0 ? "OK  " : "FAIL", `hybrid "${q}" -> want ${want}, rank ${rank >= 0 ? rank + 1 : "-"}`);
    hits.forEach((e, i) => console.log(`     ${i + 1}. #${e.id}${byId[e.id] ? ` [${byId[e.id]}]` : ""} ${e.content.slice(0, 70)}`));
    if (rank < 0) {
      failed = true;
      const qv = (await client.embed({ text: q, purpose: "query" })).vector;
      const dv = embStore.get(ids[want], client.model)?.vector;
      console.log("     cosine(query, want) =", dv ? cosine(qv, dv).toFixed(3) : "no vector", "(meaning-only floor 0.35)");
    }
  }

  // 5. The memory.notes.recall tool itself (no runtime needed: store + minimal ctx).
  const tool = buildNotesRecallTool({ store, defaultK: 3 });
  const ctx = { workingDir: process.cwd(), sessionId: "smoke-embed", stepIndex: 0, signal: new AbortController().signal };
  const res = await tool.run({ query: "what does my pet like to eat?", k: 3 }, ctx);
  const got = (res.details?.entries ?? []).map((e) => e.id);
  const ok = res.status === "ok" && got.includes(ids.cat);
  if (!ok) failed = true;
  console.log(ok ? "OK  " : "FAIL", `tool memory.notes.recall -> status ${res.status}, ids [${got.join(", ")}], want #${ids.cat}`);
  console.log(String(res.output).split("\n").map((l) => `     ${l}`).join("\n"));
} catch (e) {
  fail(e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  // 6. Cleanup: memories rows go, vectors follow via ON DELETE CASCADE (foreign_keys = ON).
  const db = store.getDatabaseHandleForEmbeddings();
  for (const [k, id] of Object.entries(ids)) {
    const removed = store.remove(id);
    const left = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?").get(id).n;
    console.log("CLEANUP", k, `#${id}`, removed ? "removed" : "NOT removed", `vectors left=${left}`);
    if (!removed || left !== 0) failed = true;
  }
  store.close();
}

console.log(failed ? "RESULT FAIL" : "RESULT OK");
process.exit(failed ? 1 : 0);
