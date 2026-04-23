import { getConfig } from "../config/index.js";
import type { ModelProfile } from "../llm/model-profile.js";
import type { SessionState } from "../session/session-state.js";
import { renderTurnForPrompt } from "../session/conversation-turn.js";
import { buildStablePrefix } from "./stable-prefix.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import {
  checkBudget,
  defaultBudget,
  truncateToTokens,
} from "./token-budget.js";
import type { TokenBudgetLimits } from "./token-budget.js";

export interface BuildPromptInput {
  session: SessionState;
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  systemPersona?: string;
  tokenBudget?: number;
  /**
   * One-shot message injected into the variable tail as a `### notice`
   * section. Used by the loop detector to nudge the model out of
   * no-progress loops without invalidating the stable prefix.
   */
  transientNotice?: string;
  profile?: ModelProfile;
}

export interface BuiltPrompt {
  /** Concatenated prompt ready to be sent to llama-server. */
  text: string;
  /** Byte-stable portion suitable for KV-cache slot assignment. */
  stablePrefix: string;
  /** Variable tail included for observability/debugging. */
  tail: string;
  tokens: {
    stablePrefix: number;
    session: number;
    worldSnapshot: number;
    conversation: number;
    total: number;
  };
  limits: TokenBudgetLimits;
  truncated: boolean;
}

/**
 * Assembles the prompt with the stable prefix at the top (persona + tools +
 * capabilities + skill catalog) and the variable tail at the bottom
 * (session facts, world snapshot, conversation transcript).
 *
 * Budgeting: `tokenBudget` caps only the `session` facts/skills section.
 * The **world snapshot and conversation transcript are unbounded**: the
 * worldSnapshot is already compressed at the browser-tool layer
 * (`aria-compressor`), and dropping detail here would just force the
 * model to re-read the page; llama-server `n_ctx` is the real ceiling.
 * Since both sections live in the variable tail, expanding them does
 * not invalidate the KV-cache over the stable prefix.
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const config = getConfig();
  const budgetTotal = input.tokenBudget ?? config.agent.tokenBudget;
  const limits = defaultBudget(budgetTotal);

  const stablePrefix = buildStablePrefix({
    toolDescriptors: input.toolDescriptors,
    capabilities: input.capabilities,
    skillCatalog: input.skillCatalog,
    reasoningSystemToken: input.profile?.reasoningSystemToken,
    ...(input.systemPersona !== undefined
      ? { systemPersona: input.systemPersona }
      : {}),
  });

  const sessionSection = renderSessionSection(input.session);
  const worldSnapshot = renderWorldSnapshotSection(input.session);
  const conversation = renderConversationSection(input.session);

  const session = truncateToTokens(sessionSection, limits.session);

  const tailParts: string[] = [
    `### session`,
    session,
    ``,
    `### world`,
    worldSnapshot,
    ``,
    `### conversation`,
    conversation,
    ``,
  ];
  if (input.transientNotice && input.transientNotice.length > 0) {
    tailParts.push(`### notice`, input.transientNotice, ``);
  }
  tailParts.push(
    `### response`,
    `Emit one JSON tool call now. Use \`reply\` for natural-language answers to the user.`,
  );
  if (input.profile?.requiresPromptThinkPrefix && input.profile.reasoningStyle !== "none") {
    tailParts.push(input.profile.reasoningOpenTag.trimEnd(), ``);
  }
  const tail = tailParts.join("\n");

  const text = `${stablePrefix}\n${tail}`;

  const budgetResult = checkBudget(
    { stablePrefix, session, worldSnapshot, conversation },
    limits,
  );

  return {
    text,
    stablePrefix,
    tail,
    tokens: budgetResult.perSection,
    limits,
    truncated: session !== sessionSection,
  };
}

function renderSessionSection(session: SessionState): string {
  const facts = session.knownFacts
    .slice(-8)
    .map((fact) => `- ${fact.text}`)
    .join("\n");
  const loadedSkills =
    session.loadedSkills.length > 0
      ? session.loadedSkills
          .map((s) => `--- skill:${s.name} v${s.version} ---\n${s.body}`)
          .join("\n\n")
      : "(none)";
  return [
    `step: ${session.stepCount}`,
    `turn: ${session.turnCount}`,
    facts.length > 0 ? `known facts:\n${facts}` : `known facts: (none)`,
    ``,
    `loaded skills:`,
    loadedSkills,
  ].join("\n");
}

function renderWorldSnapshotSection(session: SessionState): string {
  const snap = session.worldSnapshot;
  if (!snap || snap.kind === "none") return "(no world snapshot available)";
  return [`kind: ${snap.kind}`, `digest: ${snap.digest}`, ``, snap.text].join(
    "\n",
  );
}

/**
 * Render the full chat transcript with no token-based trimming. The
 * `n_ctx` of llama-server is the only ceiling — if history outgrows it,
 * llama.cpp will truncate at the token layer, not here.
 */
function renderConversationSection(session: SessionState): string {
  if (session.turns.length === 0) return "(no messages yet)";
  return session.turns.map(renderTurnForPrompt).join("\n");
}
