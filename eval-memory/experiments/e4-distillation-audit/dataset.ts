/**
 * E4 distillation-audit dataset.
 *
 * Each cluster is 3-5 hand-crafted episode memories that share a
 * common thread, paired with an operator-authored **gold lesson**:
 * what a careful human would distill from those notes. The judge
 * grades the LLM's produced lesson against the gold on three axes
 * (activation / principle / coverage) at 1..5.
 *
 * Sizes intentionally small (4 clusters × 4 episodes ≈ 16 prompts).
 * The campaign can be expanded later once the consolidator prompt
 * stabilises.
 */

export interface GoldLesson {
  activation: string;
  principle: string;
  tags: readonly string[];
}

export interface DistillCluster {
  id: string;
  label: string;
  sharedTags: readonly string[];
  episodes: ReadonlyArray<{ content: string; tags?: readonly string[] }>;
  gold: GoldLesson;
  /** Per-axis rubric override. Defaults to the standard rubric in the runner. */
  rubric?: string;
}

export const DISTILL_CLUSTERS: readonly DistillCluster[] = [
  {
    id: "lint-precommit",
    label: "pre-commit hook fails on lint when staged files include vendored code",
    sharedTags: ["lint", "precommit"],
    episodes: [
      { content: "pre-commit hook failed today — eslint complained about vendor/legacy-jquery.js even though we mark it as third-party. Had to --no-verify to land the fix." },
      { content: "Same lint failure as Tuesday: eslint scans vendor/ on staged commits. Adding vendor/** to .eslintignore made the hook pass on the next try." },
      { content: "We keep hitting eslint blocking commits when vendor/ has a touched line. .eslintignore covers it but new contributors keep tripping on this until someone tells them." },
      { content: "Wrote a CONTRIBUTING.md note about .eslintignore and vendor/ after another person hit the same pre-commit wall this week." },
    ],
    gold: {
      activation: "pre-commit lint hook fails on vendor or third-party files",
      principle: "Add vendor / third-party paths to .eslintignore so the pre-commit hook does not scan them; document the convention in CONTRIBUTING.md to spare new contributors the same trap.",
      tags: ["lint", "precommit", "vendor"],
    },
  },
  {
    id: "json-bigint",
    label: "JSON.parse silently truncates large integers from upstream",
    sharedTags: ["json", "precision"],
    episodes: [
      { content: "Spent two hours chasing a mismatch between the upstream order id and ours — turned out JSON.parse mangled the trailing digits of a 19-digit id." },
      { content: "Upstream uses snowflake ids (int64). JSON.parse rounds anything >2^53 silently. Switched to fetching the raw text and using BigInt(value)." },
      { content: "Added a guard: if a numeric id in the upstream payload is >Number.MAX_SAFE_INTEGER we read it as a string before parsing the rest." },
      { content: "Postmortem note — never trust JSON.parse for ids from systems with BigInt-shaped identifiers; pull as text or run a JSON5/bigint-aware parser at the edge." },
    ],
    gold: {
      activation: "parsing JSON that contains snowflake / int64 / very large numeric ids",
      principle: "JavaScript JSON.parse silently rounds integers above 2^53. Pull the raw text and convert to BigInt (or use a bigint-aware parser) at the ingestion boundary; never compare upstream large ids after a default JSON.parse.",
      tags: ["json", "bigint", "precision"],
    },
  },
  {
    id: "user-prefers-concise",
    label: "user repeatedly asks for shorter responses",
    sharedTags: ["preference", "tone"],
    episodes: [
      { content: "User asked me to 'cut the preamble' and just give the diff. They prefer concise replies." },
      { content: "Another short-reply request from the user: 'one paragraph max'. They are clearly a low-verbosity person." },
      { content: "User said 'no need to explain unless I ask'. Reinforces the pattern: keep replies minimal." },
    ],
    gold: {
      activation: "user has consistently asked for shorter, less explanatory responses",
      principle: "Default to concise replies for this user — one paragraph maximum, no preamble, no explanation unless explicitly asked. Verbose responses regress on a stated preference.",
      tags: ["tone", "preference", "concise"],
    },
  },
  {
    id: "node-pin",
    label: "this repo's CI is pinned to Node 20",
    sharedTags: ["ci", "tooling"],
    episodes: [
      { content: "CI failed on a Node 22 native-binding ABI mismatch. The repo's .nvmrc says 20.11; matrix in actions/setup-node also pins 20." },
      { content: "When I forgot to nvm use 20 locally, husky pre-push tripped because better-sqlite3 was rebuilt against the wrong Node ABI." },
      { content: "Bumped a contributor: 'the engines field says 20, please nvm use 20 — 22 will break native modules silently'." },
      { content: "package.json engines.node='20.x', .nvmrc='20.11', CI matrix '[20]'. This is The Pin and nobody should change it without an ADR." },
    ],
    gold: {
      activation: "working on this repo locally or in CI; native modules involved",
      principle: "This repo is hard-pinned to Node 20. Native modules (better-sqlite3, ...) rebuild against the local ABI — using Node 22 produces silent failures at pre-push or CI. Always `nvm use 20` before touching dependencies; changing the pin requires an ADR.",
      tags: ["ci", "node", "abi"],
    },
  },
];
