/**
 * E2E reflection probe — minimal: 3 prefill turns + drain → inspect DB.
 * Bypasses LoCoMo / vitest. Uses runCampaignScenario("full_v2") so
 * the exact same bootstrap+config+subprocess flow as the real eval.
 *
 * Triggers segmentation reflection on turn 3 (triggerEveryTurns=3).
 *
 * Usage: tsx eval-memory/scripts/probe-reflection-e2e.mts
 */
import { runCampaignScenario } from "../harness/run-campaign-scenario.js";
import Database from "better-sqlite3";

const SESSIONS = [
  "[session_1 — 3:15 pm on 8 May, 2023] Caroline: I went to an LGBTQ support group meeting today. Meaningful connections. [session_1 — 3:22 pm] Melanie: Wonderful!",
  "[session_2 — 7:30 pm on 25 May, 2023] Melanie: Ran charity race for mental health today! [session_2 — 7:40 pm] Caroline: Wow congrats.",
  "[session_3 — 8:31 pm on 9 June, 2023] Caroline: Exploring adoption agencies that work with LGBTQ+ singles. [session_3 — 8:38] Melanie: Amazing!",
  "[session_4 — 9:00 pm on 20 June, 2023] Melanie: Steve and I hit our 5 year anniversary. [session_4 — 9:05] Caroline: So happy for you!",
  "[session_5 — 7:30 pm on 5 July, 2023] Caroline: Started GRE prep for grad school. [session_5 — 7:40] Melanie: You got this!",
  "[session_6 — 8:00 pm on 10 July, 2023] Melanie: Kids started baseball. [session_6] Caroline: Cute!",
];
const PROMPTS = SESSIONS.map(
  (s) => `${s}\n\nStore this conversation context using memory.notes.store and reply OK.`,
);

const URL_LLM = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL ?? "http://127.0.0.1:19091";
process.env.ATOMIC_AGENT_LLAMA_URL = URL_LLM;

const t0 = Date.now();
console.log(`[e2e-probe] starting full_v2 scenario with ${PROMPTS.length} prompts`);

const out = await runCampaignScenario({
  profile: "full_v2",
  configOptions: { llamaUrl: URL_LLM },
  driver: {
    prompts: PROMPTS,
    maxSteps: 8,
    timeoutMs: 600_000,
    postLastReplyDrainMs: 90_000, // 90s drain so reflection has time
    perReplyDrainMs: 0,
  },
  label: "probe-reflection-e2e",
  cleanup: false,
});

const elapsed = Date.now() - t0;
console.log(`[e2e-probe] done in ${(elapsed / 1000).toFixed(1)}s`);
console.log(`[e2e-probe] stateDir: ${out.stateDir}`);
console.log(`[e2e-probe] replies:`, out.result.replyLinesPerPrompt ?? "n/a");

const db = new Database(`${out.stateDir}/memory.sqlite`, { readonly: true });
const facts = db.prepare("SELECT COUNT(*) as c FROM profile_facts").get() as { c: number };
const mems = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
const reflectionNotes = db
  .prepare("SELECT COUNT(*) as c FROM memories WHERE tags LIKE '%reflection%'")
  .get() as { c: number };
console.log(`[e2e-probe] profile_facts: ${facts.c}, memories: ${mems.c}, reflection-tagged: ${reflectionNotes.c}`);
const sample = db.prepare("SELECT id, tags, substr(content,1,100) as content FROM memories ORDER BY id").all();
for (const row of sample as Array<{ id: number; tags: string; content: string }>) {
  console.log(`  mem #${row.id} ${row.tags} :: ${row.content}`);
}
db.close();

console.log(`\n[e2e-probe] To inspect debug logs: cat .cursor/debug-2ee5d7.log`);
