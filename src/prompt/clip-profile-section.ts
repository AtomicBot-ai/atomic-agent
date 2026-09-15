import type { ProfileFact } from "../memory/profile-store.js";
import {
  PROFILE_SECTION_EMPTY,
  renderProfileLine,
  selectProfileFacts,
  type RenderProfileOptions,
} from "../memory/profile-renderer.js";

import { estimateTokens, estimateTokensFromCounts } from "./token-budget.js";

/**
 * What the `memory.profile.maxTokens` clip did to `### profile` on one
 * prompt build. Counts only — never a key or a value — so it can go to
 * logs, traces and the TUI feed as it is.
 */
export interface ProfileClipStats {
  /** Facts that made it into the section. */
  rendered: number;
  /** Facts the vote / keyword filters selected but the budget left out. */
  dropped: number;
  /** How many of `dropped` are pinned. */
  pinnedDropped: number;
  /** The ceiling that was applied. */
  maxTokens: number;
}

export interface ClippedProfileSection {
  text: string;
  /** Present only when at least one selected fact was left out. */
  clip?: ProfileClipStats;
}

export interface ClipProfileSectionOptions extends RenderProfileOptions {
  maxTokens: number;
}

/**
 * Render `### profile` under `maxTokens`, one whole fact line at a time.
 *
 * The section used to be rendered in full and then cut by
 * `truncateToTokens`, which stopped at a character offset: the last
 * fact that fit was cut mid-value, and everything after it — sorted by
 * key, so whatever happened to sort late — vanished behind a bare
 * `[truncated]` (issue #407). Here:
 *
 *  - lines come in render order, pinned facts first, so a contextual
 *    fact is always left out before a pinned one;
 *  - a line that does not fit is skipped whole and the packer moves on,
 *    so one long fact cannot push out every shorter one behind it;
 *  - the last line says how many facts are missing, and the counts come
 *    back in `clip` so the caller can warn someone.
 *
 * Deterministic: the same facts and options always give the same text.
 */
export function clipProfileSection(
  facts: readonly ProfileFact[],
  options: ClipProfileSectionOptions,
): ClippedProfileSection {
  const { maxTokens } = options;
  const selected = selectProfileFacts(facts, options);
  if (selected.length === 0) {
    const empty = fits(PROFILE_SECTION_EMPTY, maxTokens);
    return { text: empty ? PROFILE_SECTION_EMPTY : "" };
  }
  const lines = selected.map(renderProfileLine);
  const full = lines.join("\n");
  if (estimateTokens(full) <= maxTokens) return { text: full };

  // Room for the marker at its longest: the count it will print can
  // only be smaller, and its word count never changes.
  const reserve = measure(omittedMarker(lines.length));
  const kept: string[] = [];
  let chars = 0;
  let words = 0;
  let dropped = 0;
  let pinnedDropped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const size = measure(line);
    // `kept.length + 1` newlines join the kept lines, this one and the
    // marker. Summed counts equal a scan of the joined text because
    // every line starts with a non-space character.
    const cost = estimateTokensFromCounts(
      chars + size.chars + reserve.chars + kept.length + 1,
      words + size.words + reserve.words,
    );
    if (cost <= maxTokens) {
      kept.push(line);
      chars += size.chars;
      words += size.words;
    } else {
      dropped += 1;
      if (selected[i]!.pinned) pinnedDropped += 1;
    }
  }
  const marker = omittedMarker(dropped);
  const text =
    kept.length > 0
      ? [...kept, marker].join("\n")
      : fits(marker, maxTokens)
        ? marker
        : "";
  return {
    text,
    clip: { rendered: kept.length, dropped, pinnedDropped, maxTokens },
  };
}

/** The line that stands in for the facts left out. */
function omittedMarker(count: number): string {
  const noun = count === 1 ? "fact" : "facts";
  return `… [truncated] ${count} more profile ${noun} not shown (memory.profile.maxTokens)`;
}

function measure(line: string): { chars: number; words: number } {
  return { chars: line.length, words: line.trim().split(/\s+/).length };
}

function fits(text: string, maxTokens: number): boolean {
  return estimateTokens(text) <= maxTokens;
}
