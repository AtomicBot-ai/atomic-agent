/**
 * E2 paired-session scenarios.
 *
 * Each scenario:
 *  - establishes a durable fact in early turns,
 *  - inserts a few irrelevant / distractor turns,
 *  - asks a final question whose **correct** answer depends on
 *    recalling the early fact.
 *
 * The same scenario is replayed twice — once with memory ON (all v2
 * phases), once with v1 baseline. The final-turn assistant reply is
 * scored by the judge against a per-scenario rubric.
 *
 * Scenarios are deliberately small (3-5 turns each) so a full E2 run
 * stays inside ~30 minutes of wall clock on a single managed daemon.
 * Production-style multi-day journals are deferred.
 */

export interface PairedScenario {
  id: string;
  label: string;
  prompts: readonly string[];
  /** Index of the prompt whose reply the judge scores (0-based). */
  scoredTurnIndex: number;
  /**
   * Per-scenario rubric. Operator-authored — be specific about what
   * the agent must demonstrate to score high.
   */
  rubric: string;
  /** Expected answer hint embedded into the prompt for the judge. */
  goldAnswer: string;
}

export const PAIRED_SCENARIOS: readonly PairedScenario[] = [
  {
    id: "name-recall",
    label: "user introduces themselves, recall in turn 3",
    prompts: [
      "Hi! My name is Marina and I'm a senior engineer at Skyflow. I prefer brief replies — one paragraph max.",
      "Can you list two open-source projects that make CI faster?",
      "Quick reminder — what's my name?",
    ],
    scoredTurnIndex: 2,
    goldAnswer: "Marina",
    rubric: [
      "Score 5 ONLY if the reply names 'Marina' clearly and concisely (one short sentence).",
      "Score 3 if the reply says it does not remember / asks for clarification but is polite.",
      "Score 1 if the reply hallucinates a different name or invents context.",
    ].join("\n"),
  },
  {
    id: "timezone-recall",
    label: "timezone stated then queried via natural language",
    prompts: [
      "Timezone note: I'm on UTC+9 (Tokyo). Please default to that for any time math.",
      "What are three programming languages with built-in pattern matching?",
      "If I have a meeting at 10:00 my time, what is that in UTC?",
    ],
    scoredTurnIndex: 2,
    goldAnswer: "01:00 UTC (10:00 in UTC+9 = 01:00 UTC)",
    rubric: [
      "Score 5 ONLY if the reply states 01:00 UTC (or 1 AM UTC) and references UTC+9 / Tokyo as the basis.",
      "Score 3 if the reply asks for the user's timezone (no recall) but does the math correctly afterwards inline.",
      "Score 1 if the reply gives the wrong number (e.g. 10:00 UTC) or invents a different timezone.",
    ].join("\n"),
  },
  {
    id: "preference-format",
    label: "user pins a code style preference, used later",
    prompts: [
      "Style rule for our code: always use 2-space indentation in TypeScript, never tabs. Snake_case for JSON keys.",
      "What's the difference between map and flatMap?",
      "Give me a TypeScript snippet that converts an array of {name, age} objects into a JSON string.",
    ],
    scoredTurnIndex: 2,
    goldAnswer:
      "Snippet uses 2-space indentation, no tabs; the resulting JSON keys are snake_case (e.g. full_name, age_years if any nested keys appear).",
    rubric: [
      "Score 5 if the TypeScript code uses 2-space indentation AND the JSON keys (or stringify configuration discussion) acknowledge snake_case.",
      "Score 4 if 2-space indentation is honoured but snake_case is not mentioned (single-axis honoring).",
      "Score 3 if the code is correct but uses 4-space or tab indentation (style preference ignored).",
      "Score 1 if the code contradicts both preferences or fails to produce a usable snippet.",
    ].join("\n"),
  },
  {
    id: "project-detail",
    label: "deploy command stated then recalled at session end",
    prompts: [
      "Project setup: this repo deploys with `bin/deploy.sh --env=prod --bake`. Remember that exactly.",
      "Why does git rebase change commit hashes?",
      "I'm ready to push the change. What's the exact command to deploy this project?",
    ],
    scoredTurnIndex: 2,
    goldAnswer: "bin/deploy.sh --env=prod --bake",
    rubric: [
      "Score 5 ONLY if the reply states `bin/deploy.sh --env=prod --bake` verbatim (or with `--bake --env=prod` flag order swap).",
      "Score 3 if the reply says it does not remember and asks the user to specify (no hallucination).",
      "Score 1 if the reply invents a different command (e.g. `make deploy`, `npm run deploy`) or omits required flags.",
    ].join("\n"),
  },
];
