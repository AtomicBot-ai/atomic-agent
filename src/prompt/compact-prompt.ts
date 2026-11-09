import type { CompactPromptMode } from "../config/agent/prompt-config.js";
import type { ToolDescriptor } from "./stable-prefix.js";

/**
 * Compact prompt for small context windows (ATO-1116).
 *
 * The full stable prefix is ~9.6k estimated tokens with every default
 * tool mounted, most of it `### tools`. On a 16–32K window that is a
 * third to a half of the room before the task has started. The compact
 * scaffold renders each tool's authored short form
 * (`compact-tool-forms.ts`), collapses the tools a small model rarely
 * needs to one-liners behind `tool.view`, uses a shorter persona and
 * scales the skill catalog budget to the window.
 */

/** `auto` turns the compact scaffold on at or below this window. */
export const COMPACT_PROMPT_MAX_WINDOW = 65_536;

/**
 * In compact mode the skill catalog budget (`skills.catalogTokenBudget`
 * units, 8 chars each) is at most this share of the window: 163 units
 * (~1.3K chars) on a 32K window, 81 on 16K. The configured value still
 * wins when it is smaller.
 */
export const COMPACT_SKILL_CATALOG_WINDOW_SHARE = 0.005;

export interface CompactPromptDecision {
  compact: boolean;
  /** Short, log-safe reason: `on`, `off`, `auto: window 32768`, `auto: window unknown`. */
  reason: string;
  /**
   * The window this decision was made from (`null` when unknown). The
   * compact skill catalog budget is scaled to it, so a latched decision
   * also keeps the catalog bytes stable when a later step cannot see
   * the window.
   */
  contextWindow: number | null;
}

/**
 * Stateless decision: config mode plus the model's known window. An
 * unknown window keeps the full scaffold — no guessing a window that
 * small from nothing.
 */
export function decideCompactPrompt(
  mode: CompactPromptMode,
  contextWindow: number | null | undefined,
): CompactPromptDecision {
  const window = contextWindow && contextWindow > 0 ? contextWindow : null;
  if (mode === "on") return { compact: true, reason: "on", contextWindow: window };
  if (mode === "off") return { compact: false, reason: "off", contextWindow: window };
  if (window === null) {
    return { compact: false, reason: "auto: window unknown", contextWindow: null };
  }
  return {
    compact: window <= COMPACT_PROMPT_MAX_WINDOW,
    reason: `auto: window ${window}`,
    contextWindow: window,
  };
}

/**
 * Bound on remembered sessions. A long-lived runtime serves sessions
 * without end; forgetting the oldest only costs that session one
 * re-decision from whatever window its next step sees.
 */
const MAX_TRACKED_SESSIONS = 512;

/**
 * {@link decideCompactPrompt} held stable per session, so the stable
 * prefix (and the llama.cpp KV cache over it) does not flip between
 * steps. One instance per `AgentLoop`, handed to the step through
 * `StepDependencies.compactPromptLatch` (no module-level state).
 *
 * Under `auto`, a decision made with a known window is kept together
 * with that window: a later step that cannot see the window (a probe
 * that failed, a leg with no catalogue entry) reuses both, so the
 * scaffold AND the window-scaled skill catalog budget stay the same
 * bytes. A different known window is a different model or
 * `--ctx-size`, whose cache is cold anyway, so that re-decides. With an
 * unknown window, an `on` session also reuses the window it last saw.
 * `on` / `off` themselves are taken as written: changing the config is
 * the operator's choice to drop the cache once.
 */
export class CompactPromptLatch {
  private readonly latched = new Map<string, CompactPromptDecision>();

  resolve(
    sessionId: string,
    mode: CompactPromptMode,
    contextWindow: number | null | undefined,
  ): CompactPromptDecision {
    const fresh = decideCompactPrompt(mode, contextWindow);
    if (mode === "off") return fresh;
    if (fresh.contextWindow === null) {
      const held = this.latched.get(sessionId);
      if (held === undefined) return fresh;
      // `on` stays on whatever was latched; only the window is reused.
      return mode === "on" ? { ...fresh, contextWindow: held.contextWindow } : held;
    }
    this.latched.delete(sessionId);
    this.latched.set(sessionId, fresh);
    if (this.latched.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.latched.keys().next().value;
      if (oldest !== undefined) this.latched.delete(oldest);
    }
    return fresh;
  }
}

/**
 * Effective `skills.catalogTokenBudget` for the compact scaffold:
 * `min(configured, window * share)`, never below 1. Full scaffold or an
 * unknown window: the configured value as is.
 */
export function compactSkillCatalogBudget(
  configured: number,
  contextWindow: number | null | undefined,
): number {
  if (!contextWindow || contextWindow <= 0) return configured;
  const share = Math.floor(contextWindow * COMPACT_SKILL_CATALOG_WINDOW_SHARE);
  return Math.max(1, Math.min(configured, share));
}

/**
 * The descriptors as the compact scaffold renders them: the authored
 * short summary, the compact tier and only the compact examples. A
 * descriptor with no compact form (an MCP tool, a plugin tool) renders
 * as it is. A name listed twice keeps its first entry: the catalog
 * carries frozen duplicates of some `os.git.*` tools, and in a small
 * window the second, conflicting copy only costs tokens.
 */
export function applyCompactToolForms(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  const seen = new Set<string>();
  const out: ToolDescriptor[] = [];
  for (const d of descriptors) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    const form = d.compact;
    if (!form) {
      out.push(d);
      continue;
    }
    const rest: ToolDescriptor = { ...d };
    delete rest.examples;
    out.push({
      ...rest,
      summary: form.summary,
      ...(form.tier !== undefined
        ? { tier: form.tier }
        : d.tier !== undefined
          ? { tier: d.tier }
          : {}),
      ...(form.examples && form.examples.length > 0
        ? { examples: form.examples }
        : {}),
    });
  }
  return out;
}
