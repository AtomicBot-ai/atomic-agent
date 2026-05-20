#!/usr/bin/env node
/**
 * Fast reflection probe. Bypasses the multi-turn driver / agent loop
 * and sends a single reflection completion to llama-server with the
 * production grammar + prompt + slot id. Used to test
 * "what does the model emit when reflection sees a prefill-style
 * input?" without paying the 5+ minute cost of a real LoCoMo run.
 *
 * Usage:
 *   node eval-memory/scripts/probe-reflection.mjs [--typed]
 *                                                 [--scenario=prefill|qa|raw_dialog]
 *                                                 [--slot=1]
 *                                                 [--url=http://127.0.0.1:19091]
 *                                                 [--n=1]
 */
import { buildReflectionPrompt } from "../../dist/memory/reflection/reflection-prompt.js";
import { REFLECTION_GRAMMAR } from "../../dist/memory/reflection/reflection-grammar.js";
import { parseReflectionOutput } from "../../dist/memory/reflection/reflection-parser.js";

// Experimental "any-speaker" reflection prefix. Designed for evaluation
// benchmarks (LoCoMo, LongMemEval) where the user message is a dump of
// a third-party conversation transcript rather than the user's own
// statements. Differences from REFLECTION_STABLE_PREFIX_TYPED:
//   - removes "Only durable content explicitly stated by the user"
//   - removes "Content introduced only by the assistant ... forbidden"
//   - adds "Treat ANY participant in the USER message as a source"
//   - allows SET key=value to capture facts about named third parties
//     (e.g. SET caroline_career_goal=...)
const ANY_SPEAKER_PREFIX = `You are a memory extractor for an assistant that helps the user track multi-party conversations.
Given the last USER and ASSISTANT messages, output durable things worth remembering across sessions about ANY participant mentioned (the user, named third parties, or shared context).

Two output channels:
- SET key=value    atomic key/value facts about ANY participant or topic (e.g. caroline_career_goal=mental_health_counseling, melanie_wedding_year=2018, current_project=adoption_research). Rendered into every future prompt, so keep them small and canonical.
- NOTE [type=X] body  freeform observations worth recalling later. ALWAYS prefix the body with one of [type=event], [type=behavior], [type=knowledge], or [type=skill]. Stored but NOT auto-rendered; looked up on demand.

NOTE types (pick exactly one per line):
- [type=event]      a specific happening at a particular time, with participants/location when known.
- [type=behavior]   a recurring pattern, routine, or established solution.
- [type=knowledge]  static factual content (concepts, relationships, life circumstances).
- [type=skill]      a replicable how-to with concrete tools, steps, and outcomes.

Rules:
- Treat ANY content in the USER message as content worth extracting, including dialog between third parties (e.g. "[session_N] Caroline: ...").
- Extract concrete events, relationships, decisions, preferences, plans, and life circumstances for every named participant.
- Use snake_case keys with the participant name as a prefix when the fact concerns a specific person (e.g. caroline_partner_status, melanie_kids_count).
- Use SET for atomic single-valued facts. Use NOTE for narrative episodes, decisions, or multi-attribute context.
- Keep each SET value under 200 characters and each NOTE body under 500 characters.
- Skip pure pleasantries, weather, transient moods.
- If a SET already captures the fact, do not also emit a NOTE repeating it.
- If there is truly nothing concrete worth remembering, output exactly: NONE
- Otherwise output up to six lines total.
`;

function buildAnySpeakerPrompt(input) {
  const user = input.userMessage.replace(/\s+/g, " ").trim().slice(0, 999);
  const assistant = input.assistantReply.replace(/\s+/g, " ").trim().slice(0, 999);
  return `${ANY_SPEAKER_PREFIX}\nUSER: ${user}\nASSISTANT: ${assistant}\n\n### output\n`;
}

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .map(([k, v = "true"]) => [k, v]),
);

const URL = args.url ?? "http://127.0.0.1:19091";
const SLOT = Number(args.slot ?? "1");
const N = Number(args.n ?? "1");
const TYPED = "typed" in args;
const SCENARIO = args.scenario ?? "prefill";

// Synthesised Caroline/Melanie prefill — shape + length mirrors what
// the LoCoMo runner injects (~4500-5000 chars, single user message
// dumping a conversation transcript with "[session_N - HH:MM]" headers).
const PREFILL_USER_MSG = `[session_3 — 7:55 pm on 9 June, 2023] Caroline: Hey Melanie! How's it going? I wanted to tell you about the school event I went to today. I gave a talk about my transgender journey to a class of high schoolers — about transitioning 3 years ago, the bumps along the way, how my support system of friends, family, and mentors carried me through. The principal asked me to speak as part of their LGBTQ+ awareness week, and the kids had so many questions. Some were curious, some were challenging, but all of them were respectful in their own way. I came out of it feeling really proud — like maybe I made a difference for at least one kid in that room who's quietly figuring things out.
[session_3 — 8:12 pm on 9 June, 2023] Melanie: That's incredible, Caroline! Honestly, what you did takes real courage. Sharing something that vulnerable with a roomful of teenagers? I don't think I could do that. You're definitely making a difference — even if just one kid heard you and thought "okay, maybe I'm not alone," that's huge. How did you feel beforehand? I'd be a nervous wreck.
[session_3 — 8:18 pm on 9 June, 2023] Caroline: I was honestly terrified. I almost cancelled the night before. But I kept thinking about how isolated I felt when I was their age — there was nobody who looked like me, nobody whose story I could relate to. If I could be that person for someone, even just one kid, it would be worth all the anxiety. So I drank a lot of coffee, practiced in front of the mirror, and just showed up. The first five minutes felt like an out-of-body experience, but then I settled in.
[session_3 — 8:24 pm on 9 June, 2023] Melanie: That's such a beautiful reason to push through fear. Also — drinking coffee before a public speaking thing is BOLD. You're braver than I'll ever be. So how are you doing otherwise? How's the adoption research going? I remember last time you mentioned looking into agencies.
[session_3 — 8:31 pm on 9 June, 2023] Caroline: Adoption stuff is moving slowly but surely. I've narrowed it down to two agencies that explicitly work with LGBTQ+ singles — both have good reputations and reasonable timelines. I'm also looking into career options in mental health counseling because I think that would let me give back in a different way. Maybe a master's in social work next year. It's a lot to think about, but it feels like the right direction. How about you? How are the kids? How's married life?
[session_3 — 8:38 pm on 9 June, 2023] Melanie: Kids are great, chaotic as always. The boys started baseball this spring and they're obsessed. Married life is good — Steve and I just hit five years, which is wild to me. We celebrated with a weekend trip to that little inn near the lake. Just the two of us, which was rare and amazing. I'm honestly really proud of where we are. He's been such a steady presence through everything.`;

const QA_USER_MSG = `Question: What did Caroline research? Answer concisely from what you remember about the earlier conversations.`;
const QA_ASSISTANT = `Caroline researched adoption agencies, specifically LGBTQ+-friendly ones, and was also exploring career options in mental health counseling.`;

const RAW_DIALOG_USER = `[session_1 — 3:15 pm on 8 May, 2023] Caroline: I went to an LGBTQ support group meeting today. Made some really meaningful connections.
[session_1 — 3:22 pm on 8 May, 2023] Melanie: That's wonderful! Glad you found that community.`;

function buildInput() {
  if (SCENARIO === "qa") {
    return { userMessage: QA_USER_MSG, assistantReply: QA_ASSISTANT };
  }
  if (SCENARIO === "raw_dialog") {
    return { userMessage: RAW_DIALOG_USER, assistantReply: "OK" };
  }
  return { userMessage: PREFILL_USER_MSG, assistantReply: "OK" };
}

const ANY_SPEAKER = "anySpeaker" in args || args.mode === "any_speaker";
const TRANSCRIPT_MODE = "transcript" in args;

// Simulate Phase B segmentation transcript: 3 consecutive prefill
// pairs (USER = dialog dump, ASSISTANT = "OK"). Matches the shape
// the agent loop hands `reflectionRunner.reflect` when
// `segmentation.enabled=true, windowTurns=5` and the loop just
// flushed three back-to-back prefill turns.
const TRANSCRIPT_PAIRS = [
  { user: RAW_DIALOG_USER, assistant: "OK" },
  { user: PREFILL_USER_MSG, assistant: "OK" },
  { user: QA_USER_MSG, assistant: QA_ASSISTANT },
];

async function probe(seq) {
  const input = buildInput();
  const promptInput = TRANSCRIPT_MODE
    ? {
        userMessage: TRANSCRIPT_PAIRS[TRANSCRIPT_PAIRS.length - 1].user,
        assistantReply: TRANSCRIPT_PAIRS[TRANSCRIPT_PAIRS.length - 1].assistant,
        transcript: TRANSCRIPT_PAIRS,
      }
    : input;
  // Use the production buildReflectionPrompt with `anySpeaker: true`
  // (config v19) so the probe exercises the real prompt that ships
  // in dist/. The local buildAnySpeakerPrompt fallback stays for
  // historical comparison runs but is no longer the default path.
  const prompt = buildReflectionPrompt({
    ...promptInput,
    ...(TYPED ? { typedNotes: true } : {}),
    ...(ANY_SPEAKER ? { anySpeaker: true } : {}),
  });

  const body = {
    prompt,
    grammar: REFLECTION_GRAMMAR,
    temperature: 0.2,
    n_predict: 800,
    cache_prompt: true,
    slot_id: SLOT,
    stop: [],
  };

  const t0 = Date.now();
  const res = await fetch(`${URL}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const tookMs = Date.now() - t0;
  const content = String(json.content ?? "");
  const parsed = parseReflectionOutput(content);

  console.log(`\n[run ${seq}/${N}] scenario=${SCENARIO} typed=${TYPED} slot=${SLOT}`);
  console.log(`  prompt chars: ${prompt.length} (user msg: ${input.userMessage.length})`);
  console.log(`  llm latency: ${tookMs}ms`);
  console.log(`  completion (${content.length} chars):`);
  console.log("  ---");
  console.log(content.split("\n").map((l) => "  | " + l).join("\n"));
  console.log("  ---");
  console.log(`  parsed.kind: ${parsed.kind}`);
  if (parsed.kind === "facts") {
    console.log(`  facts: ${parsed.facts.length}, notes: ${parsed.notes.length}, evolves: ${parsed.evolves.length}`);
    for (const f of parsed.facts) console.log(`    SET ${f.key}=${f.value}`);
    for (const n of parsed.notes) console.log(`    NOTE [${(n.tags ?? []).join(",")}] ${n.body.slice(0, 80)}${n.body.length > 80 ? "…" : ""}`);
  }
}

(async () => {
  console.log(`probe-reflection: url=${URL} slot=${SLOT} typed=${TYPED} scenario=${SCENARIO} n=${N}`);
  for (let i = 1; i <= N; i += 1) {
    try {
      await probe(i);
    } catch (err) {
      console.error(`[run ${i}] error: ${err.message}`);
    }
  }
})();
