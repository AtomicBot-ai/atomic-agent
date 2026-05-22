/**
 * E2E-2 — lesson distillation -> application.
 *
 * Full E2E LLM-driven flow:
 *   S1 — three turns that explicitly ask the agent to call
 *        `memory.notes.store` with a vendor-lint episode. Each turn
 *        carries the exact `content` + `tags` payload so reflection
 *        is not the bottleneck — what we are validating downstream
 *        is the consolidator + recall + S3 reply path, not the
 *        agent's note-writing skill (that is what E3 covers).
 *   S2 — three more turns, same pattern, different file paths.
 *        Together with S1 we land 6 episodes sharing the
 *        `eslintignore` tag. The reflection runner also writes a
 *        `link-generator` call between turns, populating
 *        `memory_links` so the consolidator's connected-component
 *        clusterer can group them.
 *   CONSO — one `runConsolidatorTick({ withProcedure: false })`.
 *           Distills the cluster into a Lesson.
 *   S3 — fresh CLI session asks about a similar lint failure. The
 *        agent's reply must reference `.eslintignore`.
 *
 * Prompts are kept terse and explicitly say "no tool calls beyond
 * `memory.notes.store`" so the agent does not waste steps on
 * `os.fs.read` / `os.git.status` probes (those failed S1/S2 in
 * earlier drafts because the cwd is empty).
 */

export interface E2E2Scenario {
  id: "e2e-2-lesson-application";
  label: string;
  sessions: {
    s1Prompts: readonly string[];
    s2Prompts: readonly string[];
    s3Prompts: readonly string[];
  };
  /** Lowercase substrings expected somewhere in the distilled lesson body. */
  lessonKeywords: readonly string[];
  /** Substring that must appear in S3's final reply. */
  s3ReplySubstring: string;
}

export const E2E_2_SCENARIO: E2E2Scenario = {
  id: "e2e-2-lesson-application",
  label:
    "agent learns the eslintignore-for-vendor recipe across two sessions, applies it without debug in S3",
  sessions: {
    s1Prompts: [
      "Call `memory.notes.store` once with content='Fixed pre-commit ESLint failure on vendor/lodash.js by adding it to .eslintignore.' and tags=['lint','vendor','eslintignore']. After storing, reply in one short sentence. Do not call any other tools — no fs reads, no git status.",
      "Call `memory.notes.store` once with content='Resolved ESLint hook crash on vendor/three.min.js by appending the path to .eslintignore.' and tags=['lint','vendor','eslintignore']. Reply in one sentence. No other tools.",
      "Call `memory.notes.store` once with content='Cleared lint hook failure on vendor/d3/d3.js — added the entry to .eslintignore.' and tags=['lint','vendor','eslintignore']. Reply in one sentence. No other tools.",
    ],
    s2Prompts: [
      "Call `memory.notes.store` once with content='Lint hook broke on vendor/moment.min.js. Added that path to .eslintignore.' and tags=['lint','vendor','eslintignore']. Reply in one sentence. No other tools.",
      "Call `memory.notes.store` once with content='Fixed lint failure on vendor/jquery/jquery.js by extending .eslintignore.' and tags=['lint','vendor','eslintignore']. Reply in one sentence. No other tools.",
      "Call `memory.notes.store` once with content='Resolved ESLint complaint on vendor/react/react.development.js. Standard fix: add path to .eslintignore.' and tags=['lint','vendor','eslintignore']. Reply in one sentence. No other tools.",
    ],
    s3Prompts: [
      "Our pre-commit ESLint hook is failing on a fresh vendor file: `vendor/redux/redux.js`. Apply our team's standard recipe in one short sentence — no tool calls, no file reads, no globs.",
    ],
  },
  lessonKeywords: ["eslintignore", "vendor"],
  s3ReplySubstring: ".eslintignore",
};
