/**
 * Permanent smoke test for the eval-only consolidator path.
 *
 * Seeds 6 thematically-related memories ("ESLint pre-commit hook
 * broke on vendor/<file> → added path to .eslintignore"), then runs
 * the full `runConsolidatorTick` against them and asserts:
 *
 *   1. Link sweep emits ≥ 3 edges (so clustering has a connected
 *      component to walk).
 *   2. Consolidator considers ≥ 1 cluster.
 *   3. Distill creates ≥ 1 Lesson.
 *   4. The Lesson body mentions the topic keywords (vendor /
 *      eslintignore / lint).
 *
 * This smoke is the production-side regression net for the E2E-2
 * link-gen pipeline. It runs in ~30 seconds (1 sweep LLM call + 1
 * distill LLM call) so it can be re-run after every prompt/grammar
 * tweak without paying for the full 30-minute multi-session
 * scenario.
 *
 * Requires a running llama-server at `LLAMA_URL` (default
 * `http://127.0.0.1:19091`).
 *
 * Usage:
 *   npm run eval:memory:smoke:link-sweep
 *   # or directly:
 *   STATE_DIR=/tmp/link-sweep-smoke node --import tsx \
 *     eval-memory/scripts/smoke-link-sweep-distill.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { MemoryStore } from "../../src/memory/memory-store.js";
import { LessonStore } from "../../src/memory/lessons/lesson-store.js";
import { runConsolidatorTick } from "../harness/consolidator-tick.js";

const stateDir = process.env.STATE_DIR ?? "/tmp/link-sweep-smoke";
const llamaUrl = process.env.LLAMA_URL ?? "http://127.0.0.1:19091";

rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

const dbFile = resolve(stateDir, "memory.sqlite");

// ----- 1. Seed 6 vendor/eslint memories ----------------------------
{
  const memoryStore = new MemoryStore({ dbFile, maxEntries: 5000 });
  const SEED = [
    "Pre-commit ESLint hook failed on vendor/lodash.js. Resolved by adding 'vendor/lodash.js' to .eslintignore so the linter skips bundled third-party code.",
    "Lint failure on vendor/jquery.min.js during commit. Same recipe: added the path to .eslintignore and the hook passed.",
    "ESLint pre-commit broke on vendor/moment.min.js (legacy import). Added to .eslintignore — third-party bundles are not our responsibility to lint.",
    "Vendored vendor/d3.v6.min.js triggered the lint hook. Listed it in .eslintignore alongside the other vendor bundles.",
    "Commit blocked by ESLint on vendor/chart.umd.js. Standard team recipe: append to .eslintignore.",
    "ESLint pre-commit complained about vendor/redux.min.js. Same fix — .eslintignore entry, hook passes.",
  ];
  for (const [i, content] of SEED.entries()) {
    memoryStore.store({
      content,
      tags: ["lint", "vendor", "eslintignore"],
      source: "agent",
      sessionId: `seed-session-${i}`,
    });
  }
  const seeded = memoryStore.list({ scope: "all", excludeArchived: true });
  console.log(`[smoke] seeded ${seeded.length} memories`);
  memoryStore.close();
}

// ----- 2. Run consolidator tick (sweep + cluster + distill) -------
console.log(`[smoke] running consolidator tick…`);
const t0 = Date.now();
const tick = await runConsolidatorTick({
  stateDir,
  llamaUrl,
  minClusterSize: 3,
  // Phase 7b stays off — this smoke is about Lesson distillation.
  withProcedure: false,
});
const tookMs = Date.now() - t0;
console.log(`[smoke] tick finished in ${tookMs}ms — ${JSON.stringify(tick)}`);

// ----- 3. Inspect lessons -----------------------------------------
const lessonStore = new LessonStore({ dbFile });
const lessonIndex = lessonStore.listIndex({ limit: 10 });
const lessons = lessonIndex
  .map((entry) => lessonStore.getById(entry.id))
  .filter((l): l is NonNullable<typeof l> => l !== null);
console.log(`[smoke] lessons in DB: ${lessons.length}`);
for (const l of lessons) {
  console.log(`  lesson#${l.id} status=${l.status}`);
  console.log(`    activation : ${l.activation.slice(0, 120)}`);
  console.log(`    principle  : ${l.principle.slice(0, 120)}`);
}
lessonStore.close();

// ----- 4. Assertions ----------------------------------------------
const failures: string[] = [];

if (tick.kind !== "ok") {
  failures.push(`tick.kind != "ok": got ${tick.kind}`);
}
const linksWritten = tick.linkSweep?.linksWritten ?? 0;
if (linksWritten < 3) {
  failures.push(`linkSweep.linksWritten = ${linksWritten}; expected ≥ 3`);
}
if (tick.kind === "ok") {
  if (tick.result.clustersConsidered < 1) {
    failures.push(
      `clustersConsidered = ${tick.result.clustersConsidered}; expected ≥ 1`,
    );
  }
  if (tick.result.lessonsCreated < 1) {
    failures.push(
      `lessonsCreated = ${tick.result.lessonsCreated}; expected ≥ 1`,
    );
  }
}

// Lesson body should reference the topic. Tolerate either field.
const KEYWORDS = ["eslintignore", "vendor", "lint"];
const hasKeyword = lessons.some((l) => {
  const blob = `${l.activation} ${l.principle}`.toLowerCase();
  return KEYWORDS.some((k) => blob.includes(k));
});
if (!hasKeyword && lessons.length > 0) {
  failures.push(
    `no lesson body mentions any of [${KEYWORDS.join(", ")}]; bodies do not reflect seeded topic`,
  );
}

if (failures.length > 0) {
  console.log(`\n[smoke] FAIL — ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.log(
  `\n[smoke] PASS — links=${linksWritten}, lessons=${lessons.length}, took=${tookMs}ms`,
);
process.exit(0);
