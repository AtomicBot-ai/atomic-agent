// Live check: Core embedding module status + memory client round trip + ranking.
import { getConfig } from "../dist/config/index.js";
import { coreEmbeddingStatus, createCoreEmbeddingClient } from "../dist/local-llm/core/core-embedding.js";
import { getEmbeddingModelDef } from "../dist/local-llm/catalog/models-catalog.js";

const dataDir = getConfig().paths.localModelsDataDir;
const def = getEmbeddingModelDef("embeddinggemma-2");
const st = await coreEmbeddingStatus(dataDir);
console.log("STATUS", JSON.stringify({ state: st?.state, model_id: st?.model_id, dims: st?.dims, modalities: st?.modalities, engine: st?.engine }));
if (!st || st.dims !== 768) { console.log("FAIL dims"); process.exitCode = 1; }
const client = createCoreEmbeddingClient({ dataDir, dim: def.dim, model: def.id, prompts: def.prompts });
const docs = {
  lease: "Арендодатель передаёт квартиру по адресу ул. Ленина 5 арендатору. Залог 50 000 рублей, ежемесячная плата 40 000.",
  cat: "My cat sleeps on the windowsill all day and purrs when I come home.",
  tax: "Quarterly VAT return must be filed with the tax office before the 25th.",
};
const vec = {};
for (const [k, t] of Object.entries(docs)) {
  const t0 = Date.now(); const r = await client.embed({ text: t, purpose: "document" });
  vec[k] = r.vector; console.log("DOC", k, r.vector.length, r.model, `${Date.now() - t0}ms`);
}
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };
const queries = { "договор аренды": "lease", "kitty": "cat", "котик": "cat", "налоги": "tax" };
for (const [q, want] of Object.entries(queries)) {
  const r = await client.embed({ text: q, purpose: "query" });
  const ranked = Object.keys(vec).map(k => [k, cos(r.vector, vec[k])]).sort((a, b) => b[1] - a[1]);
  const ok = ranked[0][0] === want; if (!ok) process.exitCode = 1;
  console.log(ok ? "OK  " : "FAIL", q, "->", ranked.map(([k, s]) => `${k}:${s.toFixed(3)}`).join(" "));
}
