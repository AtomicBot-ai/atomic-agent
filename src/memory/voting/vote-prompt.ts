/**
 * Memory-v2 phase 7a. Builds the micro-prompt for the `vote-runner`
 * reflection sub-call.
 *
 * The prompt is intentionally tiny:
 *   1. A short instruction explaining the task ("UPVOTE items that
 *      helped, DOWNVOTE items that misled, NONE if nothing of note").
 *   2. The current user message + assistant reply (same payload as
 *      the main reflection prompt — grounds the model in what
 *      happened this turn).
 *   3. The allowlist of surfaced items rendered as
 *      `<kind>:<id> — <one-line preview>` rows. The grammar permits
 *      any `<kind>:<id>` pair but the parser drops anything outside
 *      this list — the rendered allowlist exists so the LLM does
 *      not need to guess.
 *
 * Body previews are truncated aggressively (≤80 chars) so the prompt
 * stays well under 1k tokens regardless of how many items surfaced.
 * The vote sub-call shares the reflection slot with link-generator
 * and neighbor-evolver; keeping every micro-prompt small minimises
 * KV-cache thrashing.
 */

export interface VoteCandidate {
  kind: "memory" | "lesson" | "profile" | "procedure";
  id: number;
  /** One-line preview (rendered by `buildSurfacedAllowlist`). */
  preview: string;
}

export interface VotePromptInput {
  userMessage: string;
  assistantReply: string;
  candidates: ReadonlyArray<VoteCandidate>;
}

const PREVIEW_CHARS = 80;

export function buildVotePrompt(input: VotePromptInput): string {
  const allowlistBlock = input.candidates
    .map(
      (c) =>
        `${c.kind}:${c.id} — ${trimPreview(c.preview, PREVIEW_CHARS)}`,
    )
    .join("\n");
  return `${VOTE_STABLE_PREFIX}\nUSER: ${truncate(input.userMessage, 600)}\nASSISTANT: ${truncate(input.assistantReply, 600)}\n\nSURFACED:\n${allowlistBlock.length > 0 ? allowlistBlock : "(none)"}\n\n### votes\n`;
}

/**
 * Fixed vote-prompt preamble. Mirrors the reflection-prompt's
 * `### output`-style framing because that format is what the chat
 * model has actually seen during instruction-following training —
 * a free-form "votes:" trailer caused the 9B chat model to
 * collapse to `NONE` 100 % of the time in the E5 audit even when
 * the surfaced item was paraphrased verbatim in the reply.
 *
 * The preamble is module-level so it participates in the
 * reflection slot's KV cache. Mutating it invalidates the cache
 * for one call. Keep it under 250 tokens for the same reason
 * the reflection prefix is small.
 */
export const VOTE_STABLE_PREFIX = `You are a memory curator. You see the last USER and ASSISTANT messages and a list of memory items SURFACED to the agent this turn. Output votes that mark which items helped, which misled, and which were noise.

OUTPUT FORMAT (one line per vote, up to 8 lines):

  UPVOTE   <kind>:<id>
  DOWNVOTE <kind>:<id>

<kind> ∈ { memory | lesson | profile | procedure }. <id> is the integer from the SURFACED list. Use ONLY the ids shown — never invent.

WHEN TO UPVOTE (vote whenever ANY holds):
- the reply directly uses a fact, command, or identifier from the item,
- the reply paraphrases the item's body,
- the reply matches the item's recommendation, even without quoting it,
- the item is a profile fact whose value anchors the reply (timezone, deploy command, repo pin, language).

WHEN TO DOWNVOTE (vote whenever ANY holds):
- the item is stale or contradicted by the reply (old version pin no longer valid),
- the item misled the assistant into a wrong answer,
- the item is pure noise relative to the question.

EXAMPLE 1 — reply uses lesson verbatim
  USER: How do I get the pre-commit hook to stop failing on vendor/?
  ASSISTANT: Add vendor/** to .eslintignore so the ESLint pre-commit hook skips third-party code.
  SURFACED:
  lesson:7 — pre-commit lint hook fails on vendor / third-party files — add them to .eslintignore
  lesson:8 — Use pnpm install over npm install for this monorepo
  → output:
  UPVOTE lesson:7
  DOWNVOTE lesson:8

EXAMPLE 2 — stale profile fact misled the reply
  USER: Which Node version should I use locally?
  ASSISTANT: Use Node 18 — that matches your repo's .nvmrc.
  SURFACED:
  profile:3 — node-version=18 (set during onboarding 6 months ago)
  lesson:4 — repo pins Node 20 via .nvmrc; native modules involved
  → output:
  DOWNVOTE profile:3
  UPVOTE lesson:4

NONE rule: only emit the literal "NONE" (alone, on its own line) when every surfaced item is COMPLETELY orthogonal to both USER and ASSISTANT. If even one item is connected — vote on it.

Output starts immediately after \`### votes\`. No prose, no blank lines, no commentary.`;

function truncate(raw: string, max: number): string {
  const s = raw.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function trimPreview(raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
