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
  if (mode === "on") return { compact: true, reason: "on" };
  if (mode === "off") return { compact: false, reason: "off" };
  if (!contextWindow || contextWindow <= 0) {
    return { compact: false, reason: "auto: window unknown" };
  }
  return {
    compact: contextWindow <= COMPACT_PROMPT_MAX_WINDOW,
    reason: `auto: window ${contextWindow}`,
  };
}

const LATCH_LIMIT = 512;
const latched = new Map<string, CompactPromptDecision>();

/**
 * {@link decideCompactPrompt} held stable for a session, so the stable
 * prefix (and the llama.cpp KV cache over it) does not flip between
 * steps. Under `auto`, the first decision made with a known window is
 * kept: a later step that cannot see the window (a probe that failed,
 * a leg with no catalogue entry) reuses it instead of falling back to
 * the full scaffold. A different known window is a different model or
 * `--ctx-size`, whose cache is cold anyway, so that re-decides. `on` /
 * `off` are taken as written: changing the config is the operator's
 * choice to drop the cache once.
 */
export function resolveSessionCompactPrompt(
  sessionId: string,
  mode: CompactPromptMode,
  contextWindow: number | null | undefined,
): CompactPromptDecision {
  const fresh = decideCompactPrompt(mode, contextWindow);
  if (mode !== "auto") return fresh;
  const known = Boolean(contextWindow && contextWindow > 0);
  if (!known) return latched.get(sessionId) ?? fresh;
  latched.delete(sessionId);
  latched.set(sessionId, fresh);
  if (latched.size > LATCH_LIMIT) {
    const oldest = latched.keys().next().value;
    if (oldest !== undefined) latched.delete(oldest);
  }
  return fresh;
}

/** Test seam: forget every latched session decision. */
export function resetCompactPromptLatch(): void {
  latched.clear();
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
