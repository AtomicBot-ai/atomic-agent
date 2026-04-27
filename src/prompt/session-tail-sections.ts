import type { SessionState } from "../session/session-state.js";
import { truncateToTokens } from "./token-budget.js";

export interface SessionSectionParts {
  /** Body only (no `###` header) for the tail, after the shared cap. */
  loaded: string | null;
  /** Body only (no `###` header) for the tail, after the shared cap. */
  facts: string | null;
  /** String passed to `checkBudget` for `loadedSkills` (no header, matches tail body). */
  budgetLoaded: string;
  /** String passed to `checkBudget` for `sessionFacts` (no header). */
  budgetFacts: string;
  truncationLoaded: boolean;
  truncationFacts: boolean;
}

/**
 * Renders and applies the shared `limits.session` cap. Order for truncation:
 * `### session-facts` first, `### loaded-skills` second (legacy: facts
 * before skills) so the tail of the combined blob is cut from skills first.
 */
export function buildSessionSectionParts(
  session: SessionState,
  sessionTokenLimit: number,
): SessionSectionParts {
  const empty: SessionSectionParts = {
    loaded: null,
    facts: null,
    budgetLoaded: "",
    budgetFacts: "",
    truncationLoaded: false,
    truncationFacts: false,
  };

  const bodyLoaded = renderLoadedSkillsBody(session);
  const bodyFacts = renderSessionFactsBody(session);
  if (bodyLoaded.length === 0 && bodyFacts.length === 0) {
    return empty;
  }

  const withFactsHeader = bodyFacts.length
    ? `### session-facts\n${bodyFacts}`
    : "";
  const withLoadedHeader = bodyLoaded.length
    ? `### loaded-skills\n${bodyLoaded}`
    : "";
  if (!withFactsHeader) {
    const t = truncateToTokens(withLoadedHeader, sessionTokenLimit);
    const loadedBody = t.startsWith("### loaded-skills\n")
      ? t.slice("### loaded-skills\n".length)
      : t;
    return {
      loaded: loadedBody,
      facts: null,
      budgetLoaded: loadedBody,
      budgetFacts: "",
      truncationLoaded: t !== withLoadedHeader,
      truncationFacts: false,
    };
  }
  if (!withLoadedHeader) {
    const t = truncateToTokens(withFactsHeader, sessionTokenLimit);
    const factsOut = t.startsWith("### session-facts\n")
      ? t.slice("### session-facts\n".length)
      : t;
    return {
      loaded: null,
      facts: factsOut,
      budgetLoaded: "",
      budgetFacts: factsOut,
      truncationLoaded: false,
      truncationFacts: t !== withFactsHeader,
    };
  }

  const combined = `${withFactsHeader}\n\n${withLoadedHeader}`;
  const truncated = truncateToTokens(combined, sessionTokenLimit);
  const marker = "\n\n### loaded-skills\n";
  const at = truncated.indexOf(marker);
  if (at < 0) {
    if (truncated.startsWith("### session-facts\n")) {
      const factsOut = truncated.slice("### session-facts\n".length);
      return {
        loaded: null,
        facts: factsOut,
        budgetLoaded: "",
        budgetFacts: factsOut,
        truncationLoaded: bodyLoaded.length > 0,
        truncationFacts: factsOut !== bodyFacts,
      };
    }
    if (truncated.startsWith("### loaded-skills\n")) {
      const lOut = truncated.slice("### loaded-skills\n".length);
      return {
        loaded: lOut,
        facts: null,
        budgetLoaded: lOut,
        budgetFacts: "",
        truncationLoaded: lOut !== bodyLoaded,
        truncationFacts: false,
      };
    }
    return {
      loaded: null,
      facts: null,
      budgetLoaded: "",
      budgetFacts: "",
      truncationLoaded: bodyLoaded.length > 0,
      truncationFacts: bodyFacts.length > 0,
    };
  }

  const fBlock = truncated.slice(0, at);
  const lBlock = truncated.slice(at + marker.length);
  const factsStripped = fBlock.startsWith("### session-facts\n")
    ? fBlock.slice("### session-facts\n".length)
    : fBlock;
  return {
    loaded: lBlock,
    facts: factsStripped,
    budgetLoaded: lBlock,
    budgetFacts: factsStripped,
    truncationLoaded: lBlock !== bodyLoaded,
    truncationFacts: factsStripped !== bodyFacts,
  };
}

function renderLoadedSkillsBody(session: SessionState): string {
  if (session.loadedSkills.length === 0) return "";
  return session.loadedSkills
    .map((s) => `--- skill:${s.name} v${s.version} ---\n${s.body}`)
    .join("\n\n");
}

function renderSessionFactsBody(session: SessionState): string {
  const recent = session.knownFacts.slice(-8);
  if (recent.length === 0) return "";
  return `known facts:\n${recent.map((f) => `- ${f.text}`).join("\n")}`;
}
