import { join } from "node:path";
import { readWorkspaceFile } from "../skills/workspace-files.js";
import type { PathRule } from "../session/workspace-context.js";
export type { PathRule };
import { truncateUtf8 } from "./project-instruction-files.js";
import { ruleBody, rulePathPatterns } from "./project-path-rules.js";

/** One path-scoped rule never adds more than this to the prompt. */
export const MAX_PATH_RULE_BYTES = 8 * 1024;
const truncatedMarker = "\n[... truncated: path rule budget reached]";

/**
 * Reads the path-scoped rule files (workspace-relative, already trusted) into
 * rules that wait for a matching file (ATO-2247). Nothing here enters the
 * prompt: the prompt attaches a rule only after a tool touched a matching path.
 * A bad file is skipped with a diagnostic, never an error.
 */
export function loadPathRules(root: string, paths: readonly string[], report: (category: string, item: string) => void): PathRule[] {
  const rules: PathRule[] = [];
  for (const path of paths) {
    let file: { path: string; content: string } | null;
    try { file = readWorkspaceFile(root, join(root, path)); }
    catch (error) {
      report("Skipped unreadable instruction", `${path} (${(error as NodeJS.ErrnoException).code ?? "unreadable"})`);
      continue;
    }
    if (!file) continue;
    if (file.content.includes("\0")) { report("Skipped binary instruction", path); continue; }
    const patterns = rulePathPatterns(file.content);
    if (!patterns.length) continue;
    let body = ruleBody(file.content);
    if (Buffer.byteLength(body) > MAX_PATH_RULE_BYTES) {
      body = truncateUtf8(body, MAX_PATH_RULE_BYTES - Buffer.byteLength(truncatedMarker)) + truncatedMarker;
      report(`Path-scoped rules exceed ${MAX_PATH_RULE_BYTES} bytes; truncated`, path);
    }
    rules.push({ path, patterns, body });
  }
  return rules;
}
