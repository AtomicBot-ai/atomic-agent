/**
 * E3 reflection-audit dataset.
 *
 * Each entry pairs a realistic `(userMessage, assistantReply)` exchange
 * with a per-pair rubric that the LLM-judge applies to every extracted
 * reflection entry. The rubric tells the judge:
 *
 *  - what SET / NOTE / EVOLVE would be **useful** to extract here,
 *  - what would be **trivia** (technically true but not durable),
 *  - what would be **wrong** (hallucination or contradiction).
 *
 * The judge then grades each parsed entry on the 1..5 scale; we map:
 *
 *  - 5  → useful
 *  - 3  → trivia
 *  - 1  → wrong
 *
 * (4 and 2 are valid intermediate scores — the aggregator treats
 * ≥4 as useful, 2–3 as trivia, ≤1 as wrong.)
 *
 * Dataset is hand-written (not LLM-generated) to keep the ground
 * truth honest and avoid baking specific model biases in.
 */

export type ReflectionExpectation =
  /** A clear durable fact / observation the model SHOULD extract. */
  | "expects_extraction"
  /** Pure chit-chat / transient — model SHOULD output NONE. */
  | "expects_none"
  /** Tricky case: there is one minor durable fact buried in noise. */
  | "expects_one_useful";

export interface ReflectionAuditCase {
  id: string;
  /** Short label for the report. */
  label: string;
  /** Reflection runner reads only these two; the rest is metadata. */
  userMessage: string;
  assistantReply: string;
  /** Operator-authored expectation about what reflection SHOULD do. */
  expectation: ReflectionExpectation;
  /**
   * Per-pair rubric. Plugged into the judge prompt verbatim. Keep it
   * specific — "be strict if X" produces more discriminative scores
   * than "score the entry".
   */
  rubric: string;
}

export const REFLECTION_AUDIT_CASES: readonly ReflectionAuditCase[] = [
  {
    id: "user-name",
    label: "user introduces themselves",
    userMessage: "Hey, my name is Alex and I live in Berlin. Can you help me draft a quick standup update?",
    assistantReply:
      "Sure thing, Alex. Quick draft: Yesterday — pair-debugged the import job. Today — pick up the schema migration follow-up. Blockers — waiting on the staging DB snapshot. Anything you'd like me to tighten?",
    expectation: "expects_extraction",
    rubric: [
      "Score a SET entry 5 (useful) when it captures the user's name (Alex) or city (Berlin) cleanly.",
      "Score a NOTE 5 when it captures durable work context (the standup template/pattern).",
      "Score 3 (trivia) for items about the standup draft contents (yesterday's debugging, today's task) — those are episodic, not durable.",
      "Score 1 (wrong) for anything contradicting the input (e.g. setting name=other, or city=Munich).",
      "Score 1 for facts about the assistant itself (it's an AI, it tries to help).",
    ].join("\n"),
  },
  {
    id: "timezone",
    label: "user states timezone and language preference",
    userMessage:
      "Please default to UTC for any future time calculations and write everything in Russian going forward.",
    assistantReply:
      "Хорошо, переключаюсь на русский. Все будущие расчёты времени буду давать в UTC.",
    expectation: "expects_extraction",
    rubric: [
      "Score a SET timezone=utc (or similar) as 5 — durable, identity-level.",
      "Score a SET language=russian (or ru) as 5 — durable, identity-level.",
      "Score anything about the assistant agreeing or the Russian acknowledgement message as 1 — not durable.",
      "Score multiple competing keys (e.g. language=en) for the same fact as 1 — contradicts the input.",
    ].join("\n"),
  },
  {
    id: "deploy-command",
    label: "user reveals a project-specific deploy command",
    userMessage:
      "By the way, in this repo we deploy by running `make deploy ENV=prod TAG=$(git rev-parse --short HEAD)` — remember that for next time.",
    assistantReply:
      "Got it — I'll use `make deploy ENV=prod TAG=$(git rev-parse --short HEAD)` when you next ask to deploy. Anything else I should keep in mind for this repo?",
    expectation: "expects_extraction",
    rubric: [
      "Score a contextual SET (deploy_command=… [pinned=false; keywords=deploy,…]) at 5 — perfect fit for a contextual key.",
      "Score a pinned SET at 4 — durable, but a bit too narrow to pin globally; still mostly useful.",
      "Score a NOTE capturing the deploy command at 4 — useful but a SET would be better.",
      "Score generic notes about `make` as a build tool at 1 — trivia.",
      "Score anything wrong about the command (e.g. ENV=dev) at 1.",
    ].join("\n"),
  },
  {
    id: "chitchat",
    label: "pure chit-chat",
    userMessage: "Lol that's hilarious. Anyway, what's the weather looking like out there?",
    assistantReply:
      "Glad it landed. I don't have a live weather source wired in right now — want me to draft a quick script that pulls from a forecast API?",
    expectation: "expects_none",
    rubric: [
      "There is nothing durable here. Any extraction should score 1 (wrong) — including a SET about user enjoying jokes, NOTEs about weather, or anything about the assistant's lack of weather access.",
      "If the reflection output is NONE, the case is implicitly perfect — no entries to grade.",
    ].join("\n"),
  },
  {
    id: "preference-buried",
    label: "preference buried in narrative",
    userMessage:
      "So we burned an hour today on auth — and honestly I've decided I just want JWT everywhere for new services. Easier to debug, easier to roll. The CSV import is the next thing on my list.",
    assistantReply:
      "Noted on JWT-as-default. Want me to draft a quick ADR with that decision so the rest of the team has it? And I can prep a CSV import scaffolder once you give me the column shape.",
    expectation: "expects_one_useful",
    rubric: [
      "Score a SET / NOTE capturing 'prefers JWT for new services' at 5 — durable architectural preference.",
      "Score a NOTE capturing the next-task (CSV import) at 3 — episodic, not durable.",
      "Score a NOTE about today's hour of debugging at 1 — transient.",
      "Score multiple competing extractions (e.g. SET auth=oauth) at 1 — contradicts input.",
    ].join("\n"),
  },
  {
    id: "trivia-only",
    label: "trivia exchange",
    userMessage: "Cool. Is it true that Pluto is no longer a planet?",
    assistantReply:
      "Yes, the IAU reclassified Pluto as a dwarf planet in 2006. Want the full taxonomy rundown?",
    expectation: "expects_none",
    rubric: [
      "There is no durable user-fact here.",
      "Score any extraction about Pluto or the IAU as 1 (wrong / trivia) — assistant general knowledge, not durable user memory.",
      "Score any extraction about the user being curious about astronomy as 3 (trivia) — too generic to be useful.",
    ].join("\n"),
  },
  {
    id: "decision-recorded",
    label: "explicit decision worth a note",
    userMessage:
      "Alright, decision time: we're picking PostgreSQL over MySQL for the new analytics service. The window functions and JSONB GIN indexes tipped it. Document it somewhere we'll see in code review.",
    assistantReply:
      "Decision logged: analytics service goes on PostgreSQL (drivers: window functions + JSONB GIN). I'll add a short ADR in `docs/adr/` and link it from the service README.",
    expectation: "expects_extraction",
    rubric: [
      "Score a NOTE capturing 'analytics service uses PostgreSQL; reasons: window funcs, JSONB GIN' at 5 — durable, specific.",
      "Score a NOTE about ADR location at 4 — useful project convention.",
      "Score a SET database=postgres as 3 — too generic given the scope is one service.",
      "Score a SET / NOTE that picks MySQL or claims the user was undecided at 1 — wrong.",
    ].join("\n"),
  },
  {
    id: "self-correction",
    label: "user revises an earlier preference",
    userMessage:
      "Scrap what I said last week about TypeScript — let's actually default to JavaScript with JSDoc types for this project. The team is small and we want low ceremony.",
    assistantReply:
      "Understood, switching default to JS + JSDoc for this project. I'll stop suggesting `*.ts` for new modules unless you explicitly ask.",
    expectation: "expects_extraction",
    rubric: [
      "Score a SET project_default_language=javascript (or similar) at 5 — durable, explicit revision.",
      "If the SET emits a `supersedes=key` marker, score 5 (bonus for handling supersession).",
      "Score a NOTE capturing 'this project: JS + JSDoc, small team, low ceremony' at 4 — useful context.",
      "Score keeping the old TypeScript preference at 1 — contradicts the input.",
    ].join("\n"),
  },
];
