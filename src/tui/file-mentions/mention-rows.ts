/**
 * The rows of the `@` palette (ATO-2472): the mention keywords a query
 * starts (`diff`, `git:5`, `problems`) or a typed kind kept as typed
 * (`src/a.ts:10-20`, `git:3`, a link), then the files and folders that
 * match it. Folders (`src/`) come from the listed files' own paths, so
 * the palette offers what Claude Code's `@` does without a second walk.
 */
import { contextSuggestions } from "../../mentions/mention-kinds.js";
import { MAX_MENTION_RESULTS, rankMentionFiles } from "./rank-mention-files.js";

export function mentionRows(
  query: string,
  files: readonly string[],
  folders: readonly string[],
  limit: number = MAX_MENTION_RESULTS,
): string[] {
  const words = contextSuggestions(query);
  const ranked = rankMentionFiles(query, [...folders, ...files], limit);
  return [...words, ...ranked.filter((p) => !words.includes(p))].slice(0, limit);
}
