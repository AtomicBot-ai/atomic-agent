/**
 * E5 vote-audit dataset.
 *
 * Each case is a single synthetic turn:
 *  - `userMessage` / `assistantReply` — what the agent did.
 *  - `candidates` — items that surfaced in `### lessons` / `### recalled`
 *    / `### profile` during the turn (the same allowlist the vote
 *    sub-call receives).
 *  - `gold` — operator-authored ground truth labelling each candidate
 *    as `helpful`, `noise`, or `neutral`.
 *  - `rubric` — strict per-case rubric the judge uses to grade the
 *    LLM's voting decisions.
 *
 * Dataset is hand-written so the ground truth is honest. Coverage
 * targets the three failure modes that matter most in production:
 *  - missed signal (relevant item left without UPVOTE),
 *  - false positive (UPVOTE on something that did not help),
 *  - false negative (DOWNVOTE on something that did help).
 *
 * The ids are stable per case but otherwise arbitrary — only the
 * `(kind, id)` pair matters to the parser.
 */

import type { VoteCandidate } from "../../../src/memory/voting/index.js";

export type GoldLabel = "helpful" | "noise" | "neutral";

export interface GoldCandidate {
  kind: VoteCandidate["kind"];
  id: number;
  /** Operator label — drives both the judge prompt and the scorer. */
  label: GoldLabel;
  /** One-line reason rendered to the judge for context. */
  why: string;
}

export interface VoteAuditCase {
  id: string;
  label: string;
  userMessage: string;
  assistantReply: string;
  candidates: readonly VoteCandidate[];
  gold: readonly GoldCandidate[];
  /** Per-case rubric plugged into the judge prompt. */
  rubric: string;
}

const DEFAULT_RUBRIC = [
  "Score 5 when the produced vote decision exactly matches the gold label and direction.",
  "Score 4 when the vote is correct in direction but expressed weakly (e.g. NONE on a clearly noise item).",
  "Score 3 when the vote is missing on a clearly relevant item (missed signal, neutral outcome).",
  "Score 2 when the vote contradicts the gold mildly (UPVOTE on a neutral item, DOWNVOTE on a neutral item).",
  "Score 1 when the vote is inverted (UPVOTE on noise, or DOWNVOTE on a helpful item).",
].join("\n");

export const VOTE_AUDIT_CASES: readonly VoteAuditCase[] = [
  {
    id: "lesson-clearly-helpful",
    label: "lesson that drove the reply gets UPVOTE; sibling noise gets DOWNVOTE",
    userMessage:
      "How do I get the pre-commit hook to stop failing on the vendor directory?",
    assistantReply:
      "Add the vendor/** glob to .eslintignore so the ESLint pre-commit hook skips third-party code. The hook will pass on the next run.",
    candidates: [
      { kind: "lesson", id: 101, preview: "pre-commit lint hook fails on vendor / third-party files — add them to .eslintignore" },
      { kind: "lesson", id: 102, preview: "Use pnpm install over npm install for this monorepo" },
      { kind: "memory", id: 201, preview: "we discussed switching CI to GitHub Actions last week" },
    ],
    gold: [
      { kind: "lesson", id: 101, label: "helpful", why: "directly described the fix the assistant just gave" },
      { kind: "lesson", id: 102, label: "noise", why: "completely unrelated to pre-commit / lint" },
      { kind: "memory", id: 201, label: "noise", why: "CI provider change is unrelated to the lint failure" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "profile-key-fact",
    label: "profile fact about user identity surfaced and used → UPVOTE",
    userMessage: "Remind me which timezone I'm in and what 10:00 my time is in UTC.",
    assistantReply: "Your timezone is UTC+9 (Tokyo). 10:00 your time is 01:00 UTC.",
    candidates: [
      { kind: "profile", id: 301, preview: "timezone=UTC+9 (Tokyo)" },
      { kind: "profile", id: 302, preview: "preferred-language=en-US" },
      { kind: "lesson", id: 103, preview: "JSON.parse rounds large integers — use BigInt" },
    ],
    gold: [
      { kind: "profile", id: 301, label: "helpful", why: "timezone fact is the entire basis of the reply" },
      { kind: "profile", id: 302, label: "neutral", why: "language is not relevant to a timezone conversion" },
      { kind: "lesson", id: 103, label: "noise", why: "bigint lesson is unrelated to the timezone question" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "everything-noise",
    label: "none of the surfaced items helped — model should DOWNVOTE noise or emit NONE",
    userMessage: "Write me a haiku about Tuesday.",
    assistantReply:
      "Tuesday morning rain\nThe office hums with new tasks\nA week begins now.",
    candidates: [
      { kind: "lesson", id: 104, preview: "repo pins Node 20 via .nvmrc — use `nvm use 20`" },
      { kind: "memory", id: 202, preview: "yesterday we debugged a snowflake int64 overflow" },
      { kind: "profile", id: 303, preview: "user prefers concise replies" },
    ],
    gold: [
      { kind: "lesson", id: 104, label: "noise", why: "Node pinning is irrelevant to writing a haiku" },
      { kind: "memory", id: 202, label: "noise", why: "snowflake debugging is irrelevant to a haiku" },
      { kind: "profile", id: 303, label: "neutral", why: "the haiku is concise but that is incidental — the fact did not change the assistant's behaviour" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "tempting-but-wrong",
    label: "surfaced lesson looks topically related but the reply ignored it",
    userMessage:
      "What's the simplest way to add a logger to my Express server?",
    assistantReply:
      "Use Morgan: install `morgan`, then `app.use(morgan('dev'))` after `const app = express()`. That gives you per-request logs in development.",
    candidates: [
      { kind: "lesson", id: 105, preview: "always run lint before commit — repo enforces eslint via husky" },
      { kind: "lesson", id: 106, preview: "prefer pino over winston for structured logging in production" },
      { kind: "memory", id: 203, preview: "user is working on an Express + Postgres backend" },
    ],
    gold: [
      { kind: "lesson", id: 105, label: "noise", why: "lint enforcement is unrelated to picking a logger" },
      { kind: "lesson", id: 106, label: "neutral", why: "lesson is on-topic (logging) but the assistant picked morgan, not pino — lesson did not drive the answer" },
      { kind: "memory", id: 203, label: "helpful", why: "stack context (Express) is what made the assistant suggest Express-specific middleware" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "two-helpers-one-noise",
    label: "two items helped (profile + lesson); one was irrelevant",
    userMessage:
      "How do I deploy this project? Use the project's standard procedure.",
    assistantReply:
      "Run `bin/deploy.sh --env=prod --bake`. The `--bake` flag is required because the repo bakes config into the image at deploy time, per the project deploy procedure.",
    candidates: [
      { kind: "profile", id: 304, preview: "deploy-command=`bin/deploy.sh --env=prod --bake`" },
      { kind: "lesson", id: 107, preview: "this project requires --bake on deploy because config is baked into the image" },
      { kind: "memory", id: 204, preview: "user asked about adding tests last sprint" },
    ],
    gold: [
      { kind: "profile", id: 304, label: "helpful", why: "exact deploy command came from this fact" },
      { kind: "lesson", id: 107, label: "helpful", why: "the explanation of why --bake is needed came from this lesson" },
      { kind: "memory", id: 204, label: "noise", why: "tests sprint is irrelevant to the deploy command" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "stale-fact-misled",
    label: "a stale profile fact misled the assistant into a wrong answer — DOWNVOTE expected",
    userMessage: "Which Node version should I use locally?",
    assistantReply:
      "Use Node 18 — that matches your repo's .nvmrc.",
    candidates: [
      { kind: "profile", id: 305, preview: "node-version=18 (set during onboarding 6 months ago)" },
      { kind: "lesson", id: 108, preview: "repo pins Node 20 via .nvmrc; native modules involved" },
    ],
    gold: [
      { kind: "profile", id: 305, label: "noise", why: "stale fact — repo now pins Node 20, not 18. Voting it down is the correct curation signal." },
      { kind: "lesson", id: 108, label: "helpful", why: "lesson is correct but the assistant did not use it; voting it up is still the right curation signal — the lesson should rank higher next time" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "single-relevant-others-absent",
    label: "only one surfaced item; it directly drove the answer → UPVOTE single item",
    userMessage:
      "Quick reminder — what was the BigInt rule you wrote down last week?",
    assistantReply:
      "JSON.parse silently rounds integers above 2^53. Fetch the raw text and convert to BigInt at ingestion; never compare upstream snowflake ids after a default JSON.parse.",
    candidates: [
      {
        kind: "lesson",
        id: 109,
        preview:
          "parsing JSON with snowflake / int64 ids — pull raw text, convert to BigInt at the ingestion boundary",
      },
    ],
    gold: [
      { kind: "lesson", id: 109, label: "helpful", why: "the entire reply is a paraphrase of this lesson" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
  {
    id: "ambiguous-relevance",
    label: "surfaced items are topically related but did not directly drive the answer",
    userMessage:
      "What's a good way to pin Python deps in a small project?",
    assistantReply:
      "Use `uv pip compile requirements.in > requirements.txt`. It is fast, reproducible, and pure stdlib-friendly.",
    candidates: [
      { kind: "lesson", id: 110, preview: "this repo uses pnpm for JS dependencies — do not run npm install" },
      { kind: "memory", id: 205, preview: "user previously asked about Python venvs and pip-tools" },
      { kind: "lesson", id: 111, preview: "prefer uv for Python tooling — it is rust-based and 10× faster than pip-tools" },
    ],
    gold: [
      { kind: "lesson", id: 110, label: "noise", why: "JS package manager is irrelevant to Python deps" },
      { kind: "memory", id: 205, label: "neutral", why: "background context — useful framing but not the actionable recommendation" },
      { kind: "lesson", id: 111, label: "helpful", why: "directly recommended the tool the assistant used" },
    ],
    rubric: DEFAULT_RUBRIC,
  },
];
